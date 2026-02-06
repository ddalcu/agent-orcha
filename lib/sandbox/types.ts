import { z } from 'zod';

export const SandboxConfigSchema = z.object({
  enabled: z.boolean().default(true),
  image: z.string().default('nikolaik/python-nodejs:python3.12-nodejs22'),
  containerPrefix: z.string().default('orcha-sbx-'),
  workdir: z.string().default('/workspace'),
  network: z.string().default('bridge'),
  memory: z.string().default('512m'),
  cpus: z.number().default(1),
  pidsLimit: z.number().default(100),
  idleTimeout: z.number().default(86_400_000), // 24h
  maxAge: z.number().default(604_800_000), // 7d
  commandTimeout: z.number().default(30_000), // 30s default per-command
  capDrop: z.array(z.string()).default(['ALL']),
  initCommands: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  binds: z.array(z.string()).default([]),
});

export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;

export interface ContainerInfo {
  containerName: string;
  containerId: string;
  status: 'created' | 'running' | 'exited' | 'unknown';
  createdAt: number;
  lastUsedAt: number;
  configHash: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
