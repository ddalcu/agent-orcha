/**
 * Helpers for creating temporary directories and fixture files for tests.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

/**
 * Creates a temporary directory with a unique name.
 * Returns the path. Caller is responsible for cleanup.
 */
export async function createTempDir(prefix = 'agent-orcha-test-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Writes a file in the given directory, creating subdirectories as needed.
 */
export async function writeFixture(dir: string, relativePath: string, content: string): Promise<string> {
  const fullPath = path.join(dir, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf-8');
  return fullPath;
}

/**
 * Removes a directory and all its contents.
 */
export async function cleanupDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup failures
  }
}
