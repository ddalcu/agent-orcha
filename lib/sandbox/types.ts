import { z } from 'zod';

export const SandboxConfigSchema = z.object({
  enabled: z.boolean().default(true),
  commandTimeout: z.number().default(30_000),
  maxOutputChars: z.number().default(50_000),
  browserCdpUrl: z.string().default('http://127.0.0.1:9222'),
});

export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;

export interface ExecResult {
  stdout: string;
  result?: string;
  error?: string;
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
}

export type SandboxStatus = 'idle' | 'detecting' | 'pulling' | 'starting' | 'running' | 'failed' | 'no-docker';
