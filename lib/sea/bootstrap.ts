import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';

/**
 * Base directory for all Agent Orcha SEA data: native binaries, public assets,
 * logs, and the default workspace. Everything lives under ~/.orcha/.
 */
export function getOrchaDir(): string {
  return path.join(os.homedir(), '.orcha');
}

const ORCHA_DIR = getOrchaDir();
const DEFAULT_WORKSPACE = path.join(ORCHA_DIR, 'workspace');

let _isSea: boolean | null = null;
let _sea: any = null;

// Exported for testing — not part of the public API
export function _resetSeaCache() { _isSea = null; _sea = null; }
export function _setSeaMock(seaMod: any) { _sea = seaMod; }

function sea(): any {
  if (_sea) return _sea;
  try {
    _sea = (process as any).getBuiltinModule?.('node:sea');
  } catch { /* not available */ }
  return _sea;
}

export function isSea(): boolean {
  if (_isSea !== null) return _isSea;
  _isSea = sea()?.isSea() === true;
  return _isSea;
}

export function getDefaultWorkspace(): string {
  return DEFAULT_WORKSPACE;
}

export function getPublicDir(): string {
  return path.join(ORCHA_DIR, 'public');
}

export function getSqliteVecPath(): string {
  const ext = process.platform === 'win32' ? 'dll'
    : process.platform === 'darwin' ? 'dylib' : 'so';
  return path.join(ORCHA_DIR, 'native', `vec0.${ext}`);
}

export function getNativeAddonPath(name: string): string {
  return path.join(ORCHA_DIR, 'native', `${name}.node`);
}

/**
 * Build a fingerprint from the binary's size and mtime.
 * Changes on every rebuild without needing to hash the entire file.
 */
function getBinarySignature(): string {
  const stat = fs.statSync(process.execPath);
  return `${stat.size}:${stat.mtimeMs}`;
}

/**
 * Extract embedded assets to the ORCHA_DIR when the binary changes.
 * Uses the binary's file signature (size + mtime) so any rebuild triggers re-extraction.
 * Called once at startup. No-op if not running as SEA.
 */
export function seaBootstrap(): void {
  if (!isSea()) return;

  const seaMod = sea();
  const version = seaMod.getAsset('version', 'utf8');
  const signatureFile = path.join(ORCHA_DIR, '.signature');
  const signature = getBinarySignature();

  const currentSignature = fs.existsSync(signatureFile)
    ? fs.readFileSync(signatureFile, 'utf-8').trim()
    : '';

  if (currentSignature === signature) return;

  console.log(`Updating Agent Orcha resources (v${version})...`);

  // Clean stale files from previous versions before extracting
  for (const dir of ['public', 'native']) {
    const dirPath = path.join(ORCHA_DIR, dir);
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true });
    }
  }

  const keys: string[] = seaMod.getAssetKeys();

  for (const key of keys) {
    if (key === 'version') continue;
    if (!key.startsWith('public/') && !key.startsWith('native/')) continue;

    const destPath = path.join(ORCHA_DIR, key);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, new Uint8Array(seaMod.getRawAsset(key)));
  }

  if (process.platform !== 'win32') {
    const nativeDir = path.join(ORCHA_DIR, 'native');
    if (fs.existsSync(nativeDir)) {
      for (const name of fs.readdirSync(nativeDir)) {
        fs.chmodSync(path.join(nativeDir, name), 0o755);
      }
    }
  }

  fs.mkdirSync(ORCHA_DIR, { recursive: true });
  fs.writeFileSync(signatureFile, signature);
  console.log('Resources updated.');
}

/**
 * Extract template files from embedded assets to a target directory.
 * Used by scaffoldWorkspace() in SEA mode.
 */
export function extractTemplates(targetDir: string): void {
  const seaMod = sea();
  if (!seaMod) return;

  const keys: string[] = seaMod.getAssetKeys();

  for (const key of keys) {
    if (!key.startsWith('templates/')) continue;

    const relativePath = key.slice('templates/'.length);
    const destPath = path.join(targetDir, relativePath);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, new Uint8Array(seaMod.getRawAsset(key)));
  }
}

/**
 * Resolve the workspace directory. Uses WORKSPACE env var if set,
 * otherwise defaults to ~/.orcha/workspace.
 */
export function resolveWorkspace(): string {
  if (process.env.WORKSPACE) return path.resolve(process.env.WORKSPACE);
  return getDefaultWorkspace();
}

/**
 * Copy template files from the repo's templates/ directory to a target directory.
 * Used by scaffoldWorkspace() in non-SEA mode.
 */
function copyTemplatesFromRepo(targetDir: string): void {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  // When running from source: lib/sea/ → project root
  // When running from dist:   dist/lib/sea/ → dist/ (templates copied there by build)
  const templatesDir = path.resolve(__dirname, '../../templates');

  if (!fs.existsSync(templatesDir)) {
    throw new Error(`Templates directory not found at ${templatesDir}. Ensure the package is properly installed.`);
  }

  const templateDirs = ['agents', 'functions', 'knowledge', 'skills', 'workflows'];
  for (const dir of templateDirs) {
    const src = path.join(templatesDir, dir);
    const dest = path.join(targetDir, dir);
    if (fs.existsSync(src)) {
      fs.cpSync(src, dest, { recursive: true });
    }
  }

  const configFiles = ['mcp.json', 'models.yaml', '.env.example'];
  for (const file of configFiles) {
    const src = path.join(templatesDir, file);
    const dest = path.join(targetDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
    }
  }
}

/**
 * Scaffold a workspace at targetDir if it doesn't already have an agents/ directory.
 * Works in both SEA and non-SEA modes.
 */
export function scaffoldWorkspace(targetDir: string): void {
  if (fs.existsSync(path.join(targetDir, 'agents'))) return;

  console.log(`\nCreating workspace at ${targetDir}...`);
  fs.mkdirSync(targetDir, { recursive: true });

  if (isSea()) {
    extractTemplates(targetDir);
  } else {
    copyTemplatesFromRepo(targetDir);
  }

  console.log('Workspace created with example configuration.\n');
}
