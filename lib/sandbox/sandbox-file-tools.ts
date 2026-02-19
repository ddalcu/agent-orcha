import { tool } from '../types/tool-factory.ts';
import { z } from 'zod';
import type { StructuredTool } from '../types/llm-types.ts';
import type { DockerManager } from './docker-manager.ts';
import type { SandboxConfig } from './types.ts';

/**
 * Validates that a path is safe and within the sandbox workdir.
 * Rejects path traversal, null bytes, and paths outside the workdir.
 */
function validatePath(filePath: string, workdir: string): string {
  if (filePath.includes('\0')) {
    throw new Error('Path contains null bytes');
  }

  // Normalize: if relative, resolve against workdir
  const resolved = filePath.startsWith('/')
    ? filePath
    : `${workdir}/${filePath}`;

  // Check for traversal outside workdir
  const normalized = resolved.replace(/\/+/g, '/').replace(/\/\.\//g, '/');
  if (normalized.includes('/../') || normalized.endsWith('/..')) {
    throw new Error(`Path traversal detected: "${filePath}"`);
  }

  if (!normalized.startsWith(workdir)) {
    throw new Error(`Path "${filePath}" is outside sandbox workdir "${workdir}"`);
  }

  return resolved;
}

/**
 * Creates a tool that reads file contents inside the Docker sandbox container.
 */
export function createSandboxReadTool(
  dockerManager: DockerManager,
  config: SandboxConfig,
): StructuredTool {
  let containerName: string | null = null;

  return tool(
    async ({ file_path, offset, limit }) => {
      if (!containerName) {
        await dockerManager.ensureImage(config.image);
        containerName = await dockerManager.getOrCreateContainer('default');
      }

      const safePath = validatePath(file_path, config.workdir);

      let command = `cat "${safePath}"`;
      if (offset !== undefined || limit !== undefined) {
        const start = (offset ?? 0) + 1; // tail is 1-indexed
        if (limit !== undefined) {
          command = `tail -n +${start} "${safePath}" | head -n ${limit}`;
        } else {
          command = `tail -n +${start} "${safePath}"`;
        }
      }

      const result = await dockerManager.execInContainer(containerName, command);

      if (result.exitCode !== 0) {
        return JSON.stringify({
          error: result.stderr || `Failed to read file (exit code ${result.exitCode})`,
        });
      }

      return JSON.stringify({
        content: result.stdout,
        path: safePath,
      });
    },
    {
      name: 'sandbox_read',
      description:
        'Read the contents of a file inside the Docker sandbox container. ' +
        'Supports optional offset and limit for reading portions of large files.',
      schema: z.object({
        file_path: z
          .string()
          .describe('Path to the file inside the container (absolute or relative to workdir)'),
        offset: z
          .number()
          .optional()
          .describe('Line offset to start reading from (0-indexed)'),
        limit: z
          .number()
          .optional()
          .describe('Maximum number of lines to read'),
      }),
    },
  );
}

/**
 * Creates a tool that writes file contents inside the Docker sandbox container.
 * Uses base64 encoding to safely transfer content including special characters.
 */
export function createSandboxWriteTool(
  dockerManager: DockerManager,
  config: SandboxConfig,
): StructuredTool {
  let containerName: string | null = null;

  return tool(
    async ({ file_path, content }) => {
      if (!containerName) {
        await dockerManager.ensureImage(config.image);
        containerName = await dockerManager.getOrCreateContainer('default');
      }

      const safePath = validatePath(file_path, config.workdir);

      // Get the directory portion of the path and ensure it exists
      const dirPath = safePath.substring(0, safePath.lastIndexOf('/'));
      if (dirPath) {
        await dockerManager.execInContainer(containerName, `mkdir -p "${dirPath}"`);
      }

      // Base64-encode on host side, decode inside container
      const b64 = Buffer.from(content, 'utf-8').toString('base64');
      const command = `echo '${b64}' | base64 -d > "${safePath}"`;

      const result = await dockerManager.execInContainer(containerName, command);

      if (result.exitCode !== 0) {
        return JSON.stringify({
          error: result.stderr || `Failed to write file (exit code ${result.exitCode})`,
        });
      }

      return JSON.stringify({
        success: true,
        path: safePath,
        bytesWritten: Buffer.byteLength(content, 'utf-8'),
      });
    },
    {
      name: 'sandbox_write',
      description:
        'Write content to a file inside the Docker sandbox container. ' +
        'Creates parent directories automatically. Overwrites existing files.',
      schema: z.object({
        file_path: z
          .string()
          .describe('Path to the file inside the container (absolute or relative to workdir)'),
        content: z
          .string()
          .describe('The content to write to the file'),
      }),
    },
  );
}

/**
 * Creates a tool that performs string-replace edits on files inside the Docker sandbox container.
 * Reads the file from the container, applies the replacement in Node.js, writes back.
 */
export function createSandboxEditTool(
  dockerManager: DockerManager,
  config: SandboxConfig,
): StructuredTool {
  let containerName: string | null = null;

  return tool(
    async ({ file_path, old_string, new_string, replace_all }) => {
      if (!containerName) {
        await dockerManager.ensureImage(config.image);
        containerName = await dockerManager.getOrCreateContainer('default');
      }

      const safePath = validatePath(file_path, config.workdir);

      // Read current contents from container
      const readResult = await dockerManager.execInContainer(
        containerName,
        `cat "${safePath}"`,
      );

      if (readResult.exitCode !== 0) {
        return JSON.stringify({
          error: readResult.stderr || `Failed to read file for editing (exit code ${readResult.exitCode})`,
        });
      }

      const original = readResult.stdout;

      if (!original.includes(old_string)) {
        return JSON.stringify({
          error: `old_string not found in "${safePath}"`,
        });
      }

      // Apply replacement
      let updated: string;
      if (replace_all) {
        updated = original.split(old_string).join(new_string);
      } else {
        const idx = original.indexOf(old_string);
        updated = original.substring(0, idx) + new_string + original.substring(idx + old_string.length);
      }

      // Write back via base64
      const b64 = Buffer.from(updated, 'utf-8').toString('base64');
      const writeResult = await dockerManager.execInContainer(
        containerName,
        `echo '${b64}' | base64 -d > "${safePath}"`,
      );

      if (writeResult.exitCode !== 0) {
        return JSON.stringify({
          error: writeResult.stderr || `Failed to write edited file (exit code ${writeResult.exitCode})`,
        });
      }

      return JSON.stringify({
        success: true,
        path: safePath,
        replacements: replace_all
          ? original.split(old_string).length - 1
          : 1,
      });
    },
    {
      name: 'sandbox_edit',
      description:
        'Edit a file inside the Docker sandbox container by replacing a specific string. ' +
        'Reads the file, performs the replacement, and writes it back. ' +
        'By default replaces only the first occurrence; set replace_all for all occurrences.',
      schema: z.object({
        file_path: z
          .string()
          .describe('Path to the file inside the container (absolute or relative to workdir)'),
        old_string: z
          .string()
          .describe('The exact string to find in the file'),
        new_string: z
          .string()
          .describe('The string to replace it with'),
        replace_all: z
          .boolean()
          .optional()
          .default(false)
          .describe('Replace all occurrences instead of just the first'),
      }),
    },
  );
}
