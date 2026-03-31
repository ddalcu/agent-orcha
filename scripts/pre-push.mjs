#!/usr/bin/env node
/**
 * Cross-platform pre-push hook (macOS, Linux, Windows).
 * Reads pushed refs from stdin to determine the commit range,
 * then checks for forbidden files, leaked secrets, TypeScript errors, and runs tests.
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[1;33m';
const NC = '\x1b[0m';

const BYPASS_MSG = `Use ${YELLOW}git push --no-verify${NC} to bypass.`;

function run(cmd) {
  return execSync(cmd, { encoding: 'utf-8' }).trim();
}

function exec(cmd) {
  try {
    const output = execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    process.stdout.write(output);
    return { ok: true, output };
  } catch (err) {
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

/** Parse pushed refs from stdin (format: <local ref> <local sha> <remote ref> <remote sha>) */
async function getPushedRange() {
  const lines = [];
  const rl = createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) lines.push(line);

  const ZERO = '0000000000000000000000000000000000000000';
  for (const line of lines) {
    const [, localSha, , remoteSha] = line.split(' ');
    if (localSha === ZERO) continue; // branch deletion
    const base = remoteSha === ZERO ? `${localSha}~10` : remoteSha;
    return { base, head: localSha };
  }
  return null;
}

const range = await getPushedRange();
if (!range) process.exit(0); // nothing to push

const FORBIDDEN_RE = /\.env$|\.pem$|\.key$|\.p12$|\.pfx$|^credentials|\/credentials/;
const SECRET_RE = /sk-[a-zA-Z0-9_-]{20,}|sk-ant-[a-zA-Z0-9_-]{20,}|AIza[a-zA-Z0-9_-]{30,}|ghp_[a-zA-Z0-9]{36}|gho_[a-zA-Z0-9]{36}|AKIA[A-Z0-9]{16}|xoxb-[a-zA-Z0-9-]+|xoxp-[a-zA-Z0-9-]+/;

// ─── Check 1: Forbidden files in pushed commits ─────────────────────────
try {
  const files = run(`git diff --name-only ${range.base}...${range.head}`).split('\n').filter(Boolean);
  const forbidden = files.filter(f => FORBIDDEN_RE.test(f));
  if (forbidden.length) {
    fail(`Blocked: push contains sensitive files:\n${forbidden.join('\n')}`);
  }
} catch { /* first push with no prior history */ }

// ─── Check 2: Secret patterns in pushed diff ────────────────────────────
try {
  const diff = run(`git diff ${range.base}...${range.head} -U0 -- ':!test/' ':!*.test.ts' ':!*.spec.ts'`);
  const leaked = diff.split('\n')
    .filter(l => l.startsWith('+') && !l.startsWith('+++'))
    .filter(l => SECRET_RE.test(l));
  if (leaked.length) {
    fail(`Blocked: possible secret/API key detected in pushed changes:\n${leaked.join('\n')}`);
  }
} catch { /* empty diff is fine */ }

// ─── Check 3: TypeScript type check ─────────────────────────────────────
console.log(`${YELLOW}Running typecheck...${NC}`);
if (!exec('npx tsc --noEmit').ok) {
  fail('Blocked: TypeScript errors found.');
}

if (existsSync('ui')) {
  console.log(`${YELLOW}Running svelte-check...${NC}`);
  if (!exec('npx --prefix ui svelte-check --fail-on-warnings=false').ok) {
    fail('Blocked: Svelte check errors found.');
  }
}
console.log(`${GREEN}Typecheck passed.${NC}`);

// ─── Check 4: Unit tests ────────────────────────────────────────────────
console.log(`${YELLOW}Running tests...${NC}`);
{
  const result = exec('npm test');
  if (!result.ok) {
    const failures = result.output.split('\n')
      .filter(l => /^✖|^ℹ |failing tests:|Error:|AssertionError/i.test(l.trim()));
    if (failures.length) console.log('\n' + failures.join('\n'));
    fail('Blocked: unit tests failed.');
  }
  const summary = result.output.split('\n').filter(l => l.trim().startsWith('ℹ ')).join('\n');
  if (summary) console.log(summary);
}

console.log(`${GREEN}All pre-push checks passed.${NC}`);
