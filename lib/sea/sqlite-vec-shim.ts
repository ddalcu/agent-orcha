// Replaces 'sqlite-vec' npm package in SEA builds via esbuild alias.
// Provides the same load() API but loads the extension from the extracted path.
import { getSqliteVecPath } from './bootstrap.ts';

export function getLoadablePath(): string {
  return getSqliteVecPath();
}

export function load(db: any): void {
  db.loadExtension(getLoadablePath());
}
