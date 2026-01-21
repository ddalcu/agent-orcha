import * as fs from 'fs/promises';
import { z } from 'zod';
import { logger } from '../logger.js';

// Schema for individual model configuration
export const ModelConfigSchema = z.object({
  provider: z.enum(['openai', 'gemini', 'anthropic', 'local']).optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string(),
  model: z.string(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().optional(),
});

// Schema for individual embedding configuration
export const EmbeddingModelConfigSchema = z.object({
  provider: z.enum(['openai', 'gemini', 'anthropic', 'local']).optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string(),
  model: z.string(),
  dimensions: z.number().optional(), // Embedding dimensions (optional, e.g., for OpenAI)
  eosToken: z.string().optional(), // EOS token to append to text (e.g., for Nomic models)
});

// Schema for the entire llm.json file
export const LLMJsonConfigSchema = z.object({
  version: z.string().default('1.0'),
  models: z.record(z.string(), ModelConfigSchema),
  embeddings: z.record(z.string(), EmbeddingModelConfigSchema),
});

export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type EmbeddingModelConfig = z.infer<typeof EmbeddingModelConfigSchema>;
export type LLMJsonConfig = z.infer<typeof LLMJsonConfigSchema>;

// Singleton config manager
let loadedConfig: LLMJsonConfig | null = null;

export async function loadLLMConfig(llmJsonPath: string): Promise<LLMJsonConfig> {
  const content = await fs.readFile(llmJsonPath, 'utf-8');
  const parsed = JSON.parse(content);
  const validated = LLMJsonConfigSchema.parse(parsed);

  loadedConfig = validated;

  logger.info(`[LLMConfig] Loaded ${Object.keys(validated.models).length} model(s), ${Object.keys(validated.embeddings).length} embedding(s)`);

  return validated;
}

export function getModelConfig(name: string): ModelConfig {
  if (!loadedConfig) {
    throw new Error('LLM config not loaded. Call loadLLMConfig() first.');
  }

  const config = loadedConfig.models[name];
  if (!config) {
    const available = Object.keys(loadedConfig.models).join(', ');
    throw new Error(`Model config "${name}" not found. Available: ${available}`);
  }

  return config;
}

export function getEmbeddingConfig(name: string): EmbeddingModelConfig {
  if (!loadedConfig) {
    throw new Error('LLM config not loaded. Call loadLLMConfig() first.');
  }

  const config = loadedConfig.embeddings[name];
  if (!config) {
    const available = Object.keys(loadedConfig.embeddings).join(', ');
    throw new Error(`Embedding config "${name}" not found. Available: ${available}`);
  }

  return config;
}

export function listModelConfigs(): string[] {
  if (!loadedConfig) {
    return [];
  }
  return Object.keys(loadedConfig.models);
}

export function listEmbeddingConfigs(): string[] {
  if (!loadedConfig) {
    return [];
  }
  return Object.keys(loadedConfig.embeddings);
}

export function isLLMConfigLoaded(): boolean {
  return loadedConfig !== null;
}
