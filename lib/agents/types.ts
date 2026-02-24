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
  format: z.enum(['text', 'json', 'structured']).default('text'),
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
  metadata: z.record(z.unknown()).optional(),
  integrations: z.array(IntegrationSchema).optional(),
  triggers: z.array(TriggerSchema).optional(),
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
