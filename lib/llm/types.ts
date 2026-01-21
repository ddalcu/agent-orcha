import { z } from 'zod';

// Re-export types from llm-config
export type {
  ModelConfig,
  EmbeddingModelConfig,
  LLMJsonConfig,
} from './llm-config.js';

export {
  ModelConfigSchema,
  EmbeddingModelConfigSchema,
  LLMJsonConfigSchema,
} from './llm-config.js';

// Schema for agent LLM reference (can be string or object with overrides)
export const AgentLLMRefSchema = z.union([
  z.string(), // Just the config name: "default"
  z.object({
    name: z.string(),
    temperature: z.number().min(0).max(2).optional(),
  }),
]);

export type AgentLLMRef = z.infer<typeof AgentLLMRefSchema>;

// Helper to resolve agent LLM reference to name and optional overrides
export function resolveAgentLLMRef(ref: AgentLLMRef): { name: string; temperature?: number } {
  if (typeof ref === 'string') {
    return { name: ref };
  }
  return ref;
}
