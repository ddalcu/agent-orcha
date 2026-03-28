import { execFile } from '../utils/child-process.ts';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { tool } from '../types/tool-factory.ts';
import { z } from 'zod';
import type { StructuredTool } from '../types/llm-types.ts';
import type { SandboxConfig, ShellResult } from './types.ts';
import type { SandboxContainer } from './sandbox-container.ts';

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

export function createSandboxShellTool(config: SandboxConfig, getContainer: () => SandboxContainer | undefined): StructuredTool {
  const inDocker = isRunningInContainer();
  const allowUnsafe = process.env['ALLOW_UNSAFE_HOST_EXECUTION'] === 'true';

  return tool(
    async ({ command, timeout }) => {
      const effectiveTimeout = timeout
        ? Math.min(timeout, config.commandTimeout)
        : config.commandTimeout;

      // Running inside Docker — execute locally as sandbox user
      if (inDocker) {
        const result = await executeShell(command, effectiveTimeout, true);
        return truncateOutput(result, config.maxOutputChars);
      }

      // Running locally with sandbox container — route through docker exec
      const sandboxContainer = getContainer();
      if (sandboxContainer?.isRunning) {
        const result = await sandboxContainer.exec(command, effectiveTimeout);
        return truncateOutput(result, config.maxOutputChars);
      }

      // Unsafe host execution explicitly allowed
      if (allowUnsafe) {
        const result = await executeShell(command, effectiveTimeout, false);
        return truncateOutput(result, config.maxOutputChars);
      }

      return JSON.stringify({
        stdout: '',
        stderr: '',
        exitCode: -1,
        error: 'Shell execution is disabled. No sandbox container running and ALLOW_UNSAFE_HOST_EXECUTION is not set.',
      });
    },
    {
      name: 'sandbox_shell',
      description:
        'Execute a shell command in a sandboxed environment. ' +
        'Commands run in an isolated container with limited permissions. ' +
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

function truncateOutput(result: ShellResult, maxChars: number): string {
  let output = JSON.stringify(result);
  if (output.length > maxChars) {
    const truncated = {
      ...result,
      stdout: result.stdout.substring(0, maxChars),
      _truncated: true,
    };
    output = JSON.stringify(truncated);
  }
  return output;
}

function executeShell(
  command: string,
  timeout: number,
  inDocker: boolean,
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const options: Record<string, unknown> = {
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      cwd: isWin ? tmpdir() : '/tmp',
    };

    if (inDocker && !isWin) {
      options.uid = SANDBOX_UID;
      options.gid = SANDBOX_GID;
    }

    const shell = isWin ? 'cmd.exe' : '/bin/sh';
    const shellArgs = isWin ? ['/c', command] : ['-c', command];
    execFile(shell, shellArgs, options, (error, stdout, stderr) => {
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
