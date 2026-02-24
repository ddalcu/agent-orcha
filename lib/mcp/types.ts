import { z } from 'zod';

export const MCPServerConfigSchema = z.preprocess(
  (data) => {
    if (typeof data === 'object' && data !== null && !('transport' in data)) {
      const d = data as Record<string, unknown>;
      if (d.command) return { ...d, transport: 'stdio' };
      if (d.url) return { ...d, transport: 'streamable-http' };
    }
    return data;
  },
  z.object({
    transport: z.enum(['stdio', 'sse', 'streamable-http', 'sse-only']),
    url: z.string().optional(),
    headers: z.record(z.string()).optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    description: z.string().optional(),
    timeout: z.number().default(30000),
    enabled: z.boolean().default(true),
  })
);

export const MCPGlobalOptionsSchema = z.object({
  throwOnLoadError: z.boolean().default(false),
  prefixToolNameWithServerName: z.boolean().default(true),
  additionalToolNamePrefix: z.string().default(''),
  defaultToolTimeout: z.number().default(30000),
});

export const MCPConfigSchema = z.object({
  version: z.string().default('1.0.0'),
  servers: z.record(MCPServerConfigSchema),
  globalOptions: MCPGlobalOptionsSchema.optional(),
});

export type MCPServerConfig = z.infer<typeof MCPServerConfigSchema>;
export type MCPGlobalOptions = z.infer<typeof MCPGlobalOptionsSchema>;
export type MCPConfig = z.infer<typeof MCPConfigSchema>;

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  invoke: (input: Record<string, unknown>) => Promise<unknown>;
}
