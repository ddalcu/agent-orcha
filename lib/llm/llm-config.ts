import * as fs from 'fs/promises';
import { z } from 'zod';
import { substituteEnvVars } from '../utils/env-substitution.ts';
import { logger } from '../logger.ts';
import type { LLMProvider } from './provider-detector.ts';

const PROVIDER_ENV_VARS: Record<LLMProvider, string> = {
  openai: 'OPENAI_API_KEY',
  gemini: 'GOOGLE_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  local: 'OPENAI_API_KEY',
};

/**
 * Resolves the API key for a given provider.
 * Priority: explicit apiKey in config > provider-specific env var.
 */
export function resolveApiKey(provider: LLMProvider, apiKey?: string): string | undefined {
  if (apiKey) {
    const resolved = substituteEnvVars(apiKey);
    if (resolved !== apiKey) return resolved || undefined;
    return apiKey;
  }
  const envVar = PROVIDER_ENV_VARS[provider];
  return process.env[envVar];
}

// Schema for individual model configuration
export const ModelConfigSchema = z.object({
  provider: z.enum(['openai', 'gemini', 'anthropic', 'local']).optional(),
  engine: z.enum(['llama-cpp', 'mlx-serve', 'ollama', 'lmstudio']).optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  model: z.string(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().optional(),
  thinkingBudget: z.number().optional(),
  reasoningBudget: z.number().optional(),
  contextSize: z.number().optional(),
});

// Schema for individual embedding configuration
export const EmbeddingModelConfigSchema = z.object({
  provider: z.enum(['openai', 'gemini', 'anthropic', 'local']).optional(),
  engine: z.enum(['llama-cpp', 'mlx-serve', 'ollama', 'lmstudio']).optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  model: z.string(),
  dimensions: z.number().optional(), // Embedding dimensions (optional, e.g., for OpenAI)
  eosToken: z.string().optional(), // EOS token to append to text (e.g., for Nomic models)
});

// Schema for the entire llm.json file
// `default` (and any key) can be either a full config object or a string pointer to another key
export const LLMJsonConfigSchema = z.object({
  version: z.string().default('1.0'),
  models: z.record(z.string(), z.union([z.string(), ModelConfigSchema])),
  embeddings: z.record(z.string(), z.union([z.string(), EmbeddingModelConfigSchema])),
  engineUrls: z.record(z.string(), z.string()).optional(),
});

export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type EmbeddingModelConfig = z.infer<typeof EmbeddingModelConfigSchema>;
export type LLMJsonConfig = z.infer<typeof LLMJsonConfigSchema>;

// Singleton config manager
let loadedConfig: LLMJsonConfig | null = null;
let loadedConfigPath: string | null = null;

/**
 * Detect engine/provider key name from a model config object.
 * Prefers `engine` (e.g. 'llama-cpp', 'mlx-serve'), falls back to `provider`.
 */
function detectKeyName(entry: Record<string, any>): string {
  return entry.engine || entry.provider || 'unknown';
}

/**
 * Migrate old format where `default` is a full config object to the new pointer format.
 * Moves the object to a named key and sets `default` to that key string.
 */
function migrateSection(section: Record<string, any>): boolean {
  const defaultVal = section['default'];
  if (defaultVal && typeof defaultVal === 'object') {
    const keyName = detectKeyName(defaultVal);
    section[keyName] = defaultVal;
    section['default'] = keyName;
    // Also migrate `default_old` if present (legacy backup key)
    const oldVal = section['default_old'];
    if (oldVal && typeof oldVal === 'object') {
      const oldKey = detectKeyName(oldVal);
      if (!section[oldKey]) {
        section[oldKey] = oldVal;
      }
      delete section['default_old'];
    }
    // Migrate `local-llama` legacy key
    const localLlama = section['local-llama'];
    if (localLlama && typeof localLlama === 'object') {
      const llamaKey = detectKeyName(localLlama);
      if (!section[llamaKey] || section['default'] !== llamaKey) {
        section[llamaKey] = localLlama;
      }
      delete section['local-llama'];
    }
    return true;
  }
  return false;
}

export async function loadLLMConfig(llmJsonPath: string): Promise<LLMJsonConfig> {
  const content = await fs.readFile(llmJsonPath, 'utf-8');
  const parsed = JSON.parse(substituteEnvVars(content));
  const validated = LLMJsonConfigSchema.parse(parsed);

  // Auto-migrate old format (default = object) to new format (default = string pointer)
  let migrated = false;
  migrated = migrateSection(validated.models) || migrated;
  migrated = migrateSection(validated.embeddings) || migrated;

  loadedConfig = validated;
  loadedConfigPath = llmJsonPath;

  if (migrated) {
    logger.info('[LLMConfig] Migrated old format to pointer-based config');
    await fs.writeFile(llmJsonPath, JSON.stringify(validated, null, 2));
  }

  logger.info(`[LLMConfig] Loaded ${Object.keys(validated.models).length} model(s), ${Object.keys(validated.embeddings).length} embedding(s)`);

  return validated;
}

export function getModelConfig(name: string): ModelConfig {
  if (!loadedConfig) {
    throw new Error('LLM config not loaded. Call loadLLMConfig() first.');
  }

  let config = loadedConfig.models[name];
  // Dereference string pointer (one level)
  if (typeof config === 'string') {
    config = loadedConfig.models[config];
  }
  if (!config || typeof config === 'string') {
    const available = Object.keys(loadedConfig.models).filter(k => typeof loadedConfig!.models[k] !== 'string').join(', ');
    throw new Error(`Model config "${name}" not found. Available: ${available}`);
  }

  return config;
}

export function getEmbeddingConfig(name: string): EmbeddingModelConfig {
  if (!loadedConfig) {
    throw new Error('LLM config not loaded. Call loadLLMConfig() first.');
  }

  let config = loadedConfig.embeddings[name];
  // Dereference string pointer (one level)
  if (typeof config === 'string') {
    config = loadedConfig.embeddings[config];
  }
  if (!config || typeof config === 'string') {
    const available = Object.keys(loadedConfig.embeddings).filter(k => typeof loadedConfig!.embeddings[k] !== 'string').join(', ');
    throw new Error(`Embedding config "${name}" not found. Available: ${available}`);
  }

  return config;
}

/**
 * Resolve the actual key name that `default` (or any pointer) references.
 * Returns the resolved key name, or the input if it's already a concrete entry.
 */
export function resolveDefaultName(section: 'models' | 'embeddings', name: string = 'default'): string {
  if (!loadedConfig) return name;
  const val = loadedConfig[section][name];
  if (typeof val === 'string') return val;
  return name;
}

export function listModelConfigs(): string[] {
  if (!loadedConfig) {
    return [];
  }
  // Filter out string pointers — only return concrete config entries
  return Object.keys(loadedConfig.models).filter(k => typeof loadedConfig!.models[k] !== 'string');
}

export function listEmbeddingConfigs(): string[] {
  if (!loadedConfig) {
    return [];
  }
  return Object.keys(loadedConfig.embeddings).filter(k => typeof loadedConfig!.embeddings[k] !== 'string');
}

export function isLLMConfigLoaded(): boolean {
  return loadedConfig !== null;
}

export function getLLMConfig(): LLMJsonConfig | null {
  return loadedConfig;
}

export function getLLMConfigPath(): string | null {
  return loadedConfigPath;
}

export async function saveLLMConfig(llmJsonPath: string, config: LLMJsonConfig): Promise<void> {
  await fs.writeFile(llmJsonPath, JSON.stringify(config, null, 2));
  loadedConfig = config;
  logger.info(`[LLMConfig] Saved config with ${Object.keys(config.models).length} model(s), ${Object.keys(config.embeddings).length} embedding(s)`);
}
