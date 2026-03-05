import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { tool } from '../types/tool-factory.ts';
import { z } from 'zod';
import type { StructuredTool } from '../types/llm-types.ts';
import type { SandboxConfig } from './types.ts';

const ALLOWED_ROOT = '/tmp';
// On macOS, /tmp is a symlink to /private/tmp
const REAL_ALLOWED_ROOT = existsSync(ALLOWED_ROOT) ? realpathSync(ALLOWED_ROOT) : ALLOWED_ROOT;

function isUnderRoot(p: string): boolean {
  return (p.startsWith(ALLOWED_ROOT + '/') || p === ALLOWED_ROOT ||
          p.startsWith(REAL_ALLOWED_ROOT + '/') || p === REAL_ALLOWED_ROOT);
}

function validatePath(rawPath: string): string {
  const resolved = resolve(ALLOWED_ROOT, rawPath);
  if (!isUnderRoot(resolved)) {
    throw new Error(`Path must be under ${ALLOWED_ROOT}. Got: ${rawPath}`);
  }
  // If the file exists, check the real path to prevent symlink escape
  if (existsSync(resolved)) {
    const real = realpathSync(resolved);
    if (!isUnderRoot(real)) {
      throw new Error(`Symlink escapes ${ALLOWED_ROOT}. Real path: ${real}`);
    }
  }
  return resolved;
}

export function createFileTools(config: SandboxConfig): StructuredTool[] {
  const readTool = tool(
    async ({ path }) => {
      try {
        const resolved = validatePath(path);
        const raw = readFileSync(resolved, 'utf-8');
        const lines = raw.split('\n');
        const numbered = lines.map((line, i) => `${i + 1}\t${line}`).join('\n');
        const truncated = numbered.length > config.maxOutputChars;
        return JSON.stringify({
          content: truncated ? numbered.substring(0, config.maxOutputChars) : numbered,
          lines: lines.length,
          size: raw.length,
          ...(truncated && { truncated: true }),
        });
      } catch (err: any) {
        return JSON.stringify({ error: err.message });
      }
    },
    {
      name: 'sandbox_file_read',
      description:
        'Read a file from the sandbox filesystem. ' +
        'Path must be under /tmp. Returns the file content as a string.',
      schema: z.object({
        path: z.string().describe('Absolute or relative path to the file (resolved under /tmp)'),
      }),
    },
  );

  const writeTool = tool(
    async ({ path, content }) => {
      try {
        const resolved = validatePath(path);
        const created = !existsSync(resolved);
        mkdirSync(dirname(resolved), { recursive: true });
        writeFileSync(resolved, content, 'utf-8');
        return JSON.stringify({
          path: resolved,
          size: content.length,
          created,
        });
      } catch (err: any) {
        return JSON.stringify({ error: err.message });
      }
    },
    {
      name: 'sandbox_file_write',
      description:
        'Create or overwrite a file in the sandbox filesystem. ' +
        'Path must be under /tmp. Parent directories are created automatically.',
      schema: z.object({
        path: z.string().describe('Absolute or relative path to the file (resolved under /tmp)'),
        content: z.string().describe('The full content to write to the file'),
      }),
    },
  );

  const editTool = tool(
    async ({ path, old_string, new_string }) => {
      try {
        const resolved = validatePath(path);
        const content = readFileSync(resolved, 'utf-8');
        const occurrences = content.split(old_string).length - 1;

        if (occurrences === 0) {
          return JSON.stringify({ error: 'old_string not found in the file' });
        }
        if (occurrences > 1) {
          return JSON.stringify({
            error: `old_string found ${occurrences} times — must be unique. Provide more surrounding context to match exactly once.`,
          });
        }

        const updated = content.replace(old_string, new_string);
        writeFileSync(resolved, updated, 'utf-8');
        return JSON.stringify({ path: resolved, replacements: 1 });
      } catch (err: any) {
        return JSON.stringify({ error: err.message });
      }
    },
    {
      name: 'sandbox_file_edit',
      description:
        'Find and replace a unique string in a file. ' +
        'The old_string must appear exactly once in the file. ' +
        'Use this for precise edits instead of rewriting the whole file.',
      schema: z.object({
        path: z.string().describe('Absolute or relative path to the file (resolved under /tmp)'),
        old_string: z.string().describe('The exact string to find (must appear exactly once)'),
        new_string: z.string().describe('The replacement string'),
      }),
    },
  );

  const insertLinesTool = tool(
    async ({ path, line, content, position }) => {
      try {
        const resolved = validatePath(path);
        const fileContent = readFileSync(resolved, 'utf-8');
        const lines = fileContent.split('\n');

        if (line < 1 || line > lines.length) {
          return JSON.stringify({ error: `Line ${line} out of range. File has ${lines.length} lines (1-indexed).` });
        }

        const newLines = content.split('\n');
        const idx = position === 'before' ? line - 1 : line;
        lines.splice(idx, 0, ...newLines);

        writeFileSync(resolved, lines.join('\n'), 'utf-8');
        return JSON.stringify({ path: resolved, insertedLines: newLines.length, atLine: idx + 1 });
      } catch (err: any) {
        return JSON.stringify({ error: err.message });
      }
    },
    {
      name: 'sandbox_file_insert',
      description:
        'Insert lines before or after a specific line number in a file. ' +
        'Line numbers are 1-indexed. Use sandbox_file_read first to see the file with line numbers.',
      schema: z.object({
        path: z.string().describe('Absolute or relative path to the file (resolved under /tmp)'),
        line: z.number().int().min(1).describe('The line number to insert before or after (1-indexed)'),
        content: z.string().describe('The content to insert (can be multiple lines)'),
        position: z.enum(['before', 'after']).default('after').describe('Insert before or after the specified line'),
      }),
    },
  );

  const replaceLinesTool = tool(
    async ({ path, start_line, end_line, content }) => {
      try {
        const resolved = validatePath(path);
        const fileContent = readFileSync(resolved, 'utf-8');
        const lines = fileContent.split('\n');

        if (start_line < 1 || start_line > lines.length) {
          return JSON.stringify({ error: `start_line ${start_line} out of range. File has ${lines.length} lines (1-indexed).` });
        }
        if (end_line < start_line || end_line > lines.length) {
          return JSON.stringify({ error: `end_line ${end_line} out of range. Must be >= start_line (${start_line}) and <= ${lines.length}.` });
        }

        const newLines = content.split('\n');
        const removedCount = end_line - start_line + 1;
        lines.splice(start_line - 1, removedCount, ...newLines);

        writeFileSync(resolved, lines.join('\n'), 'utf-8');
        return JSON.stringify({ path: resolved, removedLines: removedCount, insertedLines: newLines.length });
      } catch (err: any) {
        return JSON.stringify({ error: err.message });
      }
    },
    {
      name: 'sandbox_file_replace_lines',
      description:
        'Replace a range of lines in a file with new content. ' +
        'Line numbers are 1-indexed and inclusive. Use sandbox_file_read first to see the file with line numbers.',
      schema: z.object({
        path: z.string().describe('Absolute or relative path to the file (resolved under /tmp)'),
        start_line: z.number().int().min(1).describe('First line to replace (1-indexed, inclusive)'),
        end_line: z.number().int().min(1).describe('Last line to replace (1-indexed, inclusive)'),
        content: z.string().describe('The replacement content (can be fewer or more lines than the range)'),
      }),
    },
  );

  return [readTool, writeTool, editTool, insertLinesTool, replaceLinesTool];
}
