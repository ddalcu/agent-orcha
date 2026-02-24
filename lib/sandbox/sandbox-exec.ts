import { tool } from '../types/tool-factory.ts';
import { z } from 'zod';
import type { StructuredTool } from '../types/llm-types.ts';
import type { VmExecutor } from './vm-executor.ts';
import type { SandboxConfig } from './types.ts';

export function createSandboxExecTool(
  vmExecutor: VmExecutor,
  config: SandboxConfig,
): StructuredTool {
  return tool(
    async ({ code, timeout }) => {
      const effectiveTimeout = timeout
        ? Math.min(timeout, config.commandTimeout)
        : config.commandTimeout;

      const result = await vmExecutor.execute(code, effectiveTimeout);

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
      name: 'sandbox_exec',
      description:
        'Execute JavaScript code in an isolated sandbox. ' +
        'The code runs in an async context — you can use await. ' +
        'Use console.log() for output. Returns JSON with stdout, result, and error fields.',
      schema: z.object({
        code: z
          .string()
          .describe('JavaScript code to execute in the sandbox'),
        timeout: z
          .number()
          .optional()
          .describe('Execution timeout in milliseconds (capped by sandbox config)'),
      }),
    },
  );
}
