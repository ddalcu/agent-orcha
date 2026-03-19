import { z } from 'zod';
import { AgentLLMRefSchema } from '../llm/types.ts';
import { AgentSkillsConfigSchema } from '../skills/types.ts';
import { IntegrationSchema } from '../integrations/types.ts';
import { TriggerSchema } from '../triggers/types.ts';

export const ToolReferenceSchema = z.union([
  z.string(),
  z.object({
    name: z.string(),
    source: z.enum(['mcp', 'knowledge', 'builtin', 'custom', 'sandbox', 'project']),
    config: z.record(z.unknown()).optional(),
  }),
]);

export const OutputConfigSchema = z.object({
  format: z.enum(['text', 'structured']).default('text'),
  schema: z.record(z.unknown()).optional(),
});

export const AgentMemoryConfigSchema = z.union([
  z.boolean(),
  z.object({
    enabled: z.boolean().default(true),
    maxLines: z.number().int().positive().default(100),
  }),
]);

export type AgentMemoryConfig = z.infer<typeof AgentMemoryConfigSchema>;

export const AgentPublishConfigSchema = z.union([
  z.boolean(),
  z.object({
    enabled: z.boolean(),
    password: z.string().optional(),
  }),
]);

export type AgentPublishConfig = z.infer<typeof AgentPublishConfigSchema>;

export const AgentP2PConfigSchema = z.union([
  z.boolean(),
  z.object({ enabled: z.boolean() }),
]);

export type AgentP2PConfig = z.infer<typeof AgentP2PConfigSchema>;

export function resolveP2PConfig(config?: AgentP2PConfig): { enabled: boolean } {
  if (config === undefined || config === false) return { enabled: false };
  if (config === true) return { enabled: true };
  return { enabled: config.enabled };
}

export function resolvePublishConfig(
  config?: AgentPublishConfig
): { enabled: boolean; password?: string } {
  if (config === undefined || config === false) return { enabled: false };
  if (config === true) return { enabled: true };
  return { enabled: config.enabled, password: config.password };
}

export const AgentDefinitionSchema = z.object({
  name: z.string().describe('Unique agent identifier'),
  description: z.string().describe('Human-readable description'),
  version: z.string().default('1.0.0'),
  llm: AgentLLMRefSchema.default('default'),
  prompt: z.object({
    system: z.string().describe('System prompt for the agent'),
    inputVariables: z.array(z.string()).default([]),
  }),
  tools: z.array(ToolReferenceSchema).default([]),
  skills: AgentSkillsConfigSchema.optional(),
  output: OutputConfigSchema.optional(),
  memory: AgentMemoryConfigSchema.optional(),
  integrations: z.array(IntegrationSchema).optional(),
  triggers: z.array(TriggerSchema).optional(),
  publish: AgentPublishConfigSchema.optional(),
  p2p: AgentP2PConfigSchema.optional(),
  maxIterations: z.number().int().positive().optional(),
  sampleQuestions: z.array(z.string()).optional(),
});

export type ToolReference = z.infer<typeof ToolReferenceSchema>;
export type OutputConfig = z.infer<typeof OutputConfigSchema>;
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

export interface ToolCallRecord {
  tool: string;
  input: unknown;
  output: unknown;
  duration: number;
}

export interface AgentResult {
  output: string | Record<string, unknown>;
  metadata: {
    tokensUsed?: number;
    toolCalls?: ToolCallRecord[];
    duration: number;
    sessionId?: string;
    messagesInSession?: number;
    structuredOutputValid?: boolean;
  };
}

export interface AgentInvokeOptions {
  input: Record<string, unknown>;
  sessionId?: string;
  signal?: AbortSignal;
}

export interface AgentInstance {
  definition: AgentDefinition;
  invoke: (input: Record<string, unknown> | AgentInvokeOptions) => Promise<AgentResult>;
  stream: (input: Record<string, unknown> | AgentInvokeOptions) => AsyncGenerator<string | Record<string, unknown>, void, unknown>;
}
