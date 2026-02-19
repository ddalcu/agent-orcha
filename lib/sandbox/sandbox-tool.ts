import { tool } from '../types/tool-factory.ts';
import { z } from 'zod';
import type { StructuredTool } from '../types/llm-types.ts';
import type { DockerManager } from './docker-manager.ts';
import type { SandboxConfig } from './types.ts';

/**
 * Creates a StructuredTool that executes shell commands inside a
 * Docker sandbox container. The container is lazily created on first use.
 */
export function createSandboxExecTool(
  dockerManager: DockerManager,
  config: SandboxConfig,
): StructuredTool {
  let containerName: string | null = null;

  return tool(
    async ({ command, workdir, timeout }) => {
      // Lazy-create / reuse the container
      if (!containerName) {
        await dockerManager.ensureImage(config.image);
        containerName = await dockerManager.getOrCreateContainer('default');
      }

      const effectiveTimeout = timeout
        ? Math.min(timeout, config.commandTimeout)
        : undefined;

      const result = await dockerManager.execInContainer(
        containerName,
        command,
        workdir ?? undefined,
        effectiveTimeout,
      );

      return JSON.stringify({
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      });
    },
    {
      name: 'sandbox_exec',
      description:
        'Execute a shell command inside an isolated Docker sandbox container. ' +
        'Returns stdout, stderr, and exit code. Use this for running CLI tools, ' +
        'scripts, or any command that needs a sandboxed environment.',
      schema: z.object({
        command: z
          .string()
          .describe('The shell command to execute inside the sandbox'),
        workdir: z
          .string()
          .optional()
          .describe('Working directory inside the container (defaults to sandbox workdir)'),
        timeout: z
          .number()
          .optional()
          .describe('Command timeout in milliseconds (capped by sandbox config)'),
      }),
    },
  );
}
