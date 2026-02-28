import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tool } from '../types/tool-factory.ts';
import { z } from 'zod';
import type { StructuredTool } from '../types/llm-types.ts';
import type { SandboxConfig, ShellResult } from './types.ts';

const SANDBOX_UID = 10000;
const SANDBOX_GID = 10000;

function isRunningInContainer(): boolean {
  // Docker creates this file
  if (existsSync('/.dockerenv')) return true;

  // Podman and other OCI runtimes use /run/.containerenv
  if (existsSync('/run/.containerenv')) return true;

  // Check cgroup for container markers (docker, containerd, lxc, podman)
  try {
    const cgroup = readFileSync('/proc/1/cgroup', 'utf-8');
    if (/docker|containerd|kubepods|lxc|podman/.test(cgroup)) return true;
  } catch {
    // /proc/1/cgroup may not exist (e.g., macOS)
  }

  return false;
}

export function createSandboxShellTool(config: SandboxConfig): StructuredTool {
  const inDocker = isRunningInContainer();
  const allowUnsafe = process.env['ALLOW_UNSAFE_HOST_EXECUTION'] === 'true';

  return tool(
    async ({ command, timeout }) => {
      if (!inDocker && !allowUnsafe) {
        return JSON.stringify({
          stdout: '',
          stderr: '',
          exitCode: -1,
          error: 'Shell execution is disabled outside Docker. Set ALLOW_UNSAFE_HOST_EXECUTION=true to enable.',
        });
      }

      const effectiveTimeout = timeout
        ? Math.min(timeout, config.commandTimeout)
        : config.commandTimeout;

      const result = await executeShell(command, effectiveTimeout, inDocker);

      let output = JSON.stringify(result);
      if (output.length > config.maxOutputChars) {
        const truncated = {
          ...result,
          stdout: result.stdout.substring(0, config.maxOutputChars),
          _truncated: true,
        };
        output = JSON.stringify(truncated);
      }

      return output;
    },
    {
      name: 'sandbox_shell',
      description:
        'Execute a shell command on the host system. ' +
        'Commands run in an isolated context with limited permissions. ' +
        'Returns JSON with stdout, stderr, exitCode, and error fields.',
      schema: z.object({
        command: z.string().describe('The shell command to execute'),
        timeout: z
          .number()
          .optional()
          .describe('Execution timeout in milliseconds (capped by sandbox config)'),
      }),
    },
  );
}

function executeShell(
  command: string,
  timeout: number,
  inDocker: boolean,
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const options: Record<string, unknown> = {
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      cwd: '/tmp',
    };

    if (inDocker) {
      options.uid = SANDBOX_UID;
      options.gid = SANDBOX_GID;
    }

    execFile('/bin/sh', ['-c', command], options, (error, stdout, stderr) => {
      let exitCode = 0;
      if (error && 'code' in error && typeof error.code === 'number') {
        exitCode = error.code;
      } else if (error) {
        exitCode = 1;
      }

      resolve({
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        exitCode,
        ...(error && typeof error.code !== 'number' ? { error: error.message } : {}),
      });
    });
  });
}
