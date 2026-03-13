import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ORCHA_DIR = path.join(os.homedir(), '.orcha');
const DEFAULT_WORKSPACE = path.join(os.homedir(), 'agent-orcha-workspace');

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

/**
 * Build a fingerprint from the binary's size and mtime.
 * Changes on every rebuild without needing to hash the entire file.
 */
function getBinarySignature(): string {
  const stat = fs.statSync(process.execPath);
  return `${stat.size}:${stat.mtimeMs}`;
}

/**
 * Extract embedded assets to ~/.orcha/ when the binary changes.
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
 * Used by 'init' and 'start' (first-run scaffolding) in SEA mode.
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
