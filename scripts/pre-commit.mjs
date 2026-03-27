#!/usr/bin/env node
/**
 * Cross-platform pre-commit hook (works on macOS, Linux, and Windows).
 * Checks for forbidden files, leaked secrets, TypeScript errors, and runs tests.
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[1;33m';
const NC = '\x1b[0m';

const BYPASS_MSG = `Use ${YELLOW}git commit --no-verify${NC} to bypass.`;

/** Run a command, return stdout. Throws on non-zero exit. */
function run(cmd) {
  return execSync(cmd, { encoding: 'utf-8' }).trim();
}

/** Run a command, stream output to console. Returns { ok, output }. */
function exec(cmd) {
  try {
    const output = execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    process.stdout.write(output);
    return { ok: true, output };
  } catch (err) {
    // Print whatever output the command produced before failing
    if (err.stdout) process.stdout.write(err.stdout);
    if (err.stderr) process.stderr.write(err.stderr);
    return { ok: false, output: (err.stdout || '') + (err.stderr || '') };
  }
}

function fail(msg) {
  console.error(`${RED}${msg}${NC}`);
  console.error(BYPASS_MSG);
  process.exit(1);
}

// ─── Check 1: Forbidden files ─────────────────────────────────────────────
const FORBIDDEN_RE = /\.env$|\.pem$|\.key$|\.p12$|\.pfx$|^credentials|\/credentials/;
const stagedFiles = run('git diff --cached --name-only').split('\n').filter(Boolean);
const forbidden = stagedFiles.filter(f => FORBIDDEN_RE.test(f));
if (forbidden.length) {
  fail(`Blocked: commit contains sensitive files:\n${forbidden.join('\n')}`);
}

// ─── Check 2: Secret patterns in staged diff ──────────────────────────────
const SECRET_RE = /sk-[a-zA-Z0-9_-]{20,}|sk-ant-[a-zA-Z0-9_-]{20,}|AIza[a-zA-Z0-9_-]{30,}|ghp_[a-zA-Z0-9]{36}|gho_[a-zA-Z0-9]{36}|AKIA[A-Z0-9]{16}|xoxb-[a-zA-Z0-9-]+|xoxp-[a-zA-Z0-9-]+/;
try {
  const diff = run("git diff --cached -U0 -- ':!test/' ':!*.test.ts' ':!*.spec.ts'");
  const addedLines = diff.split('\n')
    .filter(l => l.startsWith('+') && !l.startsWith('+++'));
  const leaked = addedLines.filter(l => SECRET_RE.test(l));
  if (leaked.length) {
    fail(`Blocked: possible secret/API key detected in staged changes:\n${leaked.join('\n')}`);
  }
} catch { /* empty diff is fine */ }

// ─── Check 3: TypeScript type check ───────────────────────────────────────
console.log(`${YELLOW}Running typecheck...${NC}`);
if (!exec('npx tsc --noEmit').ok) {
  fail('Blocked: TypeScript errors found.');
}

// Svelte check (if ui directory exists)
if (existsSync('ui')) {
  console.log(`${YELLOW}Running svelte-check...${NC}`);
  if (!exec('npx --prefix ui svelte-check --fail-on-warnings=false').ok) {
    fail('Blocked: Svelte check errors found.');
  }
}
console.log(`${GREEN}Typecheck passed.${NC}`);

// ─── Check 4: Unit tests ──────────────────────────────────────────────────
console.log(`${YELLOW}Running tests...${NC}`);
{
  const result = exec('npm test');
  if (!result.ok) {
    // Show only failing tests and summary
    const lines = result.output.split('\n');
    const failures = lines.filter(l => /^✖|^ℹ |failing tests:|Error:|AssertionError/i.test(l.trim()));
    if (failures.length) {
      console.log('\n' + failures.join('\n'));
    }
    fail('Blocked: unit tests failed.');
  }
  // Show summary line
  const summary = result.output.split('\n').filter(l => l.trim().startsWith('ℹ ')).join('\n');
  if (summary) console.log(summary);
}

// ─── All clear ────────────────────────────────────────────────────────────
console.log(`${GREEN}All pre-commit checks passed.${NC}`);
