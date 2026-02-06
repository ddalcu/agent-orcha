import * as fs from 'fs/promises';
import * as path from 'path';
import type { FastifyPluginAsync } from 'fastify';
import { logger } from '../../lib/logger.js';
import { generateResourceTemplate, getResourceTypes } from '../../lib/templates/resource-templates.js';

interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
}

interface ReadQuery {
  path: string;
}

interface WriteBody {
  path: string;
  content: string;
}

interface CreateBody {
  path: string;
  content?: string;
}

interface RenameBody {
  oldPath: string;
  newPath: string;
}

interface DeleteBody {
  path: string;
}

const IGNORED = new Set(['node_modules', 'dist', '.git', '.DS_Store']);
const MAX_DEPTH = 5;

async function resolveSafePath(baseDir: string, relativePath: string): Promise<string> {
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
  // e.g. projectRoot/symlink-to-etc/passwd would pass the string check above
  // but fs.realpath reveals the true location outside the base directory
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

async function buildTree(
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

export const filesRoutes: FastifyPluginAsync = async (fastify) => {
  const baseDir = fastify.orchestrator.projectRoot;

  fastify.get('/tree', async () => {
    const tree = await buildTree(baseDir, baseDir, 0);
    return { tree };
  });

  fastify.get<{ Querystring: ReadQuery }>('/read', async (request, reply) => {
    const relativePath = request.query.path;

    if (!relativePath) {
      return reply.status(400).send({ error: 'Missing path parameter' });
    }

    let fullPath: string;
    try {
      fullPath = await resolveSafePath(baseDir, relativePath);
    } catch {
      return reply.status(400).send({ error: 'Invalid path' });
    }

    let stat;
    try {
      stat = await fs.stat(fullPath);
    } catch {
      return reply.status(404).send({ error: 'File not found' });
    }

    if (stat.isDirectory()) {
      return reply.status(400).send({ error: 'Cannot read a directory' });
    }

    const content = await fs.readFile(fullPath, 'utf-8');
    return { content, path: relativePath };
  });

  fastify.put<{ Body: WriteBody }>('/write', async (request, reply) => {
    const { path: relativePath, content } = request.body;

    if (!relativePath || content === undefined) {
      return reply.status(400).send({ error: 'Missing path or content' });
    }

    let fullPath: string;
    try {
      fullPath = await resolveSafePath(baseDir, relativePath);
    } catch {
      return reply.status(400).send({ error: 'Invalid path' });
    }

    // Only allow overwriting existing files
    try {
      const stat = await fs.stat(fullPath);
      if (stat.isDirectory()) {
        return reply.status(400).send({ error: 'Cannot write to a directory' });
      }
    } catch {
      return reply.status(404).send({ error: 'File not found — creating new files is not allowed' });
    }

    await fs.writeFile(fullPath, content, 'utf-8');
    logger.info(`[IDE] File saved: ${relativePath}`);

    // Reload the config in-memory so changes take effect without restart
    let reloaded = 'none';
    try {
      reloaded = await fastify.orchestrator.reloadFile(relativePath);
      if (reloaded !== 'none') {
        logger.info(`[IDE] Reloaded ${reloaded} config from: ${relativePath}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[IDE] Failed to reload config from ${relativePath}: ${message}`);
      return { success: true, path: relativePath, reloaded: 'error', reloadError: message };
    }

    return { success: true, path: relativePath, reloaded };
  });

  fastify.post<{ Body: CreateBody }>('/create', async (request, reply) => {
    const { path: relativePath, content = '' } = request.body;

    if (!relativePath) {
      return reply.status(400).send({ error: 'Missing path' });
    }

    let fullPath: string;
    try {
      fullPath = await resolveSafePath(baseDir, relativePath);
    } catch {
      return reply.status(400).send({ error: 'Invalid path' });
    }

    // Ensure the file does not already exist
    try {
      await fs.stat(fullPath);
      return reply.status(409).send({ error: 'File already exists' });
    } catch {
      // Expected — file should not exist
    }

    // Ensure the parent directory exists, creating it if needed
    const parentDir = path.dirname(fullPath);
    try {
      const parentStat = await fs.stat(parentDir);
      if (!parentStat.isDirectory()) {
        return reply.status(400).send({ error: 'Parent path is not a directory' });
      }
    } catch {
      // Parent doesn't exist — create it (still within safe path)
      await fs.mkdir(parentDir, { recursive: true });
    }

    await fs.writeFile(fullPath, content, 'utf-8');
    logger.info(`[IDE] File created: ${relativePath}`);

    return { success: true, path: relativePath };
  });

  fastify.post<{ Body: RenameBody }>('/rename', async (request, reply) => {
    const { oldPath, newPath } = request.body;

    if (!oldPath || !newPath) {
      return reply.status(400).send({ error: 'Missing oldPath or newPath' });
    }

    let fullOldPath: string;
    let fullNewPath: string;
    try {
      fullOldPath = await resolveSafePath(baseDir, oldPath);
      fullNewPath = await resolveSafePath(baseDir, newPath);
    } catch {
      return reply.status(400).send({ error: 'Invalid path' });
    }

    // Ensure old file exists
    try {
      const stat = await fs.stat(fullOldPath);
      if (stat.isDirectory()) {
        return reply.status(400).send({ error: 'Cannot rename a directory' });
      }
    } catch {
      return reply.status(404).send({ error: 'Source file not found' });
    }

    // Ensure new path does not already exist
    try {
      await fs.stat(fullNewPath);
      return reply.status(409).send({ error: 'A file already exists at the target path' });
    } catch {
      // Expected — target should not exist
    }

    await fs.rename(fullOldPath, fullNewPath);
    logger.info(`[IDE] File renamed: ${oldPath} → ${newPath}`);

    return { success: true, oldPath, newPath };
  });

  fastify.delete<{ Body: DeleteBody }>('/delete', async (request, reply) => {
    const { path: relativePath } = request.body;

    if (!relativePath) {
      return reply.status(400).send({ error: 'Missing path' });
    }

    let fullPath: string;
    try {
      fullPath = await resolveSafePath(baseDir, relativePath);
    } catch {
      return reply.status(400).send({ error: 'Invalid path' });
    }

    try {
      const stat = await fs.stat(fullPath);
      if (stat.isDirectory()) {
        // For skill directories, allow deleting the whole directory
        await fs.rm(fullPath, { recursive: true });
        logger.info(`[IDE] Directory deleted: ${relativePath}`);
      } else {
        await fs.unlink(fullPath);
        logger.info(`[IDE] File deleted: ${relativePath}`);
      }
    } catch {
      return reply.status(404).send({ error: 'File not found' });
    }

    return { success: true, path: relativePath };
  });

  fastify.get<{ Querystring: { type: string; name: string } }>('/template', async (request, reply) => {
    const { type, name } = request.query;

    if (!type || !name) {
      return reply.status(400).send({ error: 'Missing type or name', types: getResourceTypes() });
    }

    const result = generateResourceTemplate(type, name);
    if (!result) {
      return reply.status(400).send({ error: `Unknown resource type: ${type}`, types: getResourceTypes() });
    }

    return result;
  });
};
