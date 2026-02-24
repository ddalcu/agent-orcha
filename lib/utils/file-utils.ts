import * as fs from 'fs/promises';
import * as path from 'path';

export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
}

export const IGNORED = new Set(['node_modules', 'dist', '.git', '.DS_Store']);
export const MAX_DEPTH = 5;

export async function resolveSafePath(baseDir: string, relativePath: string): Promise<string> {
  // Block absolute paths and obvious traversal before any resolution
  if (path.isAbsolute(relativePath)) {
    throw new Error('Path traversal detected');
  }

  // String-based check first (fast reject)
  const resolved = path.resolve(baseDir, relativePath);
  const normalizedBase = path.normalize(baseDir);
  const normalizedResolved = path.normalize(resolved);

  if (
    normalizedResolved !== normalizedBase &&
    !normalizedResolved.startsWith(normalizedBase + path.sep)
  ) {
    throw new Error('Path traversal detected');
  }

  // Symlink-aware check: resolve real paths on disk to prevent symlink bypass
  const realBase = await fs.realpath(baseDir);
  let realResolved: string;
  try {
    realResolved = await fs.realpath(resolved);
  } catch {
    // File doesn't exist yet — resolve parent dir to check it's inside base
    const parentDir = path.dirname(resolved);
    try {
      const realParent = await fs.realpath(parentDir);
      if (
        realParent !== realBase &&
        !realParent.startsWith(realBase + path.sep)
      ) {
        throw new Error('Path traversal detected');
      }
    } catch {
      throw new Error('Path traversal detected');
    }
    return resolved;
  }

  if (
    realResolved !== realBase &&
    !realResolved.startsWith(realBase + path.sep)
  ) {
    throw new Error('Path traversal detected');
  }

  return resolved;
}

export async function buildTree(
  dirPath: string,
  baseDir: string,
  depth: number
): Promise<FileNode[]> {
  if (depth > MAX_DEPTH) return [];

  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const nodes: FileNode[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.') || IGNORED.has(entry.name)) continue;

    const fullPath = path.join(dirPath, entry.name);
    const relativePath = path.relative(baseDir, fullPath);

    if (entry.isDirectory()) {
      const children = await buildTree(fullPath, baseDir, depth + 1);
      nodes.push({
        name: entry.name,
        path: relativePath,
        type: 'directory',
        children,
      });
    } else {
      nodes.push({
        name: entry.name,
        path: relativePath,
        type: 'file',
      });
    }
  }

  // Sort: directories first, then alphabetical
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return nodes;
}
