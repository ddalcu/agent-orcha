import { z } from 'zod';
import { AgentLLMRefSchema } from '../llm/types.js';

export const ToolReferenceSchema = z.union([
  z.string(),
  z.object({
    name: z.string(),
    source: z.enum(['mcp', 'vector', 'builtin', 'custom']),
    config: z.record(z.unknown()).optional(),
  }),
]);

export const OutputConfigSchema = z.object({
  format: z.enum(['text', 'json', 'structured']).default('text'),
  schema: z.record(z.unknown()).optional(),
});

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
  output: OutputConfigSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
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
  };
}

export interface AgentInstance {
  definition: AgentDefinition;
  invoke: (input: Record<string, unknown>) => Promise<AgentResult>;
  stream: (input: Record<string, unknown>) => AsyncGenerator<string, void, unknown>;
}
