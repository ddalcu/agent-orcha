import { z } from 'zod';

export const SandboxConfigSchema = z.object({
  enabled: z.boolean().default(true),
  commandTimeout: z.number().default(30_000),
  maxOutputChars: z.number().default(50_000),
});

export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;

export interface ExecResult {
  stdout: string;
  result?: string;
  error?: string;
}
