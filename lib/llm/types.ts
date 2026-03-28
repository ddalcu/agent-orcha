import { z } from 'zod';

// Re-export types from llm-config
export type {
  ModelConfig,
  EmbeddingModelConfig,
  ModelsConfig,
} from './llm-config.ts';

export {
  ModelConfigSchema,
  EmbeddingModelConfigSchema,
  ModelsConfigSchema,
} from './llm-config.ts';

// Schema for per-type model references on an agent
// String shorthand: "omni" → { llm: "omni" }
// Object with temp: { llm: "omni", temperature: 0.7 }
// Per-type: { llm: "gpt4", image: "flux", video: "wan2", tts: "qwen" }
export const AgentModelRefSchema = z.union([
  z.string(),
  z.object({
    llm: z.string().optional(),
    image: z.string().optional(),
    video: z.string().optional(),
    tts: z.string().optional(),
    temperature: z.number().min(0).max(2).optional(),
  }),
]);

export type AgentModelRef = z.infer<typeof AgentModelRefSchema>;

export interface ResolvedModelRef {
  llm: string;
  image?: string;
  video?: string;
  tts?: string;
  temperature?: number;
}

// Resolve agent model reference to per-type config keys
export function resolveAgentModelRef(ref: AgentModelRef): ResolvedModelRef {
  if (typeof ref === 'string') {
    return { llm: ref };
  }
  return {
    llm: ref.llm ?? 'default',
    image: ref.image,
    video: ref.video,
    tts: ref.tts,
    temperature: ref.temperature,
  };
}
