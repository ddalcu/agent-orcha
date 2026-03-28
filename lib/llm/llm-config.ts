import * as fs from 'fs/promises';
import { z } from 'zod';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { substituteEnvVars } from '../utils/env-substitution.ts';
import { logger } from '../logger.ts';
import type { LLMProvider } from './provider-detector.ts';

const PROVIDER_ENV_VARS: Record<LLMProvider, string> = {
  openai: 'OPENAI_API_KEY',
  gemini: 'GOOGLE_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  local: 'OPENAI_API_KEY',
  omni: 'OPENAI_API_KEY', // omni doesn't need an API key, but satisfies the record type
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
  provider: z.enum(['openai', 'gemini', 'anthropic', 'local', 'omni']).optional(),
  engine: z.enum(['llama-cpp', 'mlx-serve', 'ollama', 'lmstudio']).optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().nullish(),
  model: z.string(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().optional(),
  thinkingBudget: z.number().optional(),
  reasoningBudget: z.number().optional(),
  contextSize: z.number().optional(),
  active: z.boolean().optional(),
  share: z.boolean().optional(),
});

// Schema for individual embedding configuration
export const EmbeddingModelConfigSchema = z.object({
  provider: z.enum(['openai', 'gemini', 'anthropic', 'local', 'omni']).optional(),
  engine: z.enum(['llama-cpp', 'mlx-serve', 'ollama', 'lmstudio']).optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().nullish(),
  model: z.string(),
  dimensions: z.number().optional(), // Embedding dimensions (optional, e.g., for OpenAI)
  eosToken: z.string().optional(), // EOS token to append to text (e.g., for Nomic models)
});

// Schema for image model configuration (FLUX.2, SD, etc.)
export const ImageModelConfigSchema = z.object({
  modelPath: z.string().optional().describe('Path to diffusion model'),
  clipL: z.string().optional().describe('Path to CLIP-L text encoder'),
  t5xxl: z.string().optional().describe('Path to T5-XXL text encoder (FLUX.1)'),
  llm: z.string().optional().describe('Path to LLM text encoder (FLUX.2 uses Qwen3)'),
  vae: z.string().optional().describe('Path to VAE model'),
  steps: z.number().optional().describe('Number of sampling steps'),
  width: z.number().optional().describe('Default image width'),
  height: z.number().optional().describe('Default image height'),
  description: z.string().default(''),
  share: z.boolean().optional(),
});

// Schema for TTS model configuration
export const TtsModelConfigSchema = z.object({
  modelPath: z.string().describe('Path to TTS model directory (Qwen3-TTS)'),
  voice: z.string().optional().describe('Default voice name'),
  description: z.string().default(''),
  share: z.boolean().optional(),
});

export type ImageModelConfig = z.infer<typeof ImageModelConfigSchema>;
export type TtsModelConfig = z.infer<typeof TtsModelConfigSchema>;

// Schema for video model configuration
export const VideoModelConfigSchema = z.object({
  provider: z.enum(['openai', 'omni']).optional(),
  modelPath: z.string().optional().describe('Path to video diffusion model (omni provider)'),
  model: z.string().optional().describe('Model name (API providers like OpenAI Sora)'),
  apiKey: z.string().nullish(),
  baseUrl: z.string().optional(),
  steps: z.number().optional().describe('Number of sampling steps'),
  width: z.number().optional().describe('Default frame width'),
  height: z.number().optional().describe('Default frame height'),
  fps: z.number().optional().describe('Default frames per second'),
  description: z.string().default(''),
  share: z.boolean().optional(),
});

export type VideoModelConfig = z.infer<typeof VideoModelConfigSchema>;

// Schema for the entire models config (models.yaml)
// `default` (and any key) can be either a full config object or a string pointer to another key
export const ModelsConfigSchema = z.object({
  version: z.string().default('1.0'),
  llm: z.record(z.string(), z.union([z.string(), ModelConfigSchema])),
  embeddings: z.record(z.string(), z.union([z.string(), EmbeddingModelConfigSchema])),
  image: z.record(z.string(), z.union([z.string(), ImageModelConfigSchema])).optional().nullable(),
  video: z.record(z.string(), z.union([z.string(), VideoModelConfigSchema])).optional().nullable(),
  tts: z.record(z.string(), z.union([z.string(), TtsModelConfigSchema])).optional().nullable(),
  engineUrls: z.record(z.string(), z.string()).optional(),
});

export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type EmbeddingModelConfig = z.infer<typeof EmbeddingModelConfigSchema>;
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;

// Singleton config manager
let loadedConfig: ModelsConfig | null = null;   // runtime (env vars resolved)
let rawConfig: ModelsConfig | null = null;       // disk-safe (${...} references preserved)
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

/**
 * Parse file content as YAML or JSON based on file extension.
 */
function parseConfigContent(content: string, filePath: string): unknown {
  const ext = filePath.toLowerCase();
  if (ext.endsWith('.yaml') || ext.endsWith('.yml')) {
    return parseYaml(content);
  }
  return JSON.parse(content);
}

/**
 * Migrate old `p2p` field to `share` in model entries.
 * Returns true if any migration was performed.
 */
function migrateP2pToShare(section: Record<string, any>): boolean {
  let migrated = false;
  for (const [_key, entry] of Object.entries(section)) {
    if (entry && typeof entry === 'object' && 'p2p' in entry) {
      entry.share = entry.p2p;
      delete entry.p2p;
      migrated = true;
    }
  }
  return migrated;
}

export async function loadModelsConfig(configPath: string): Promise<ModelsConfig> {
  const content = await fs.readFile(configPath, 'utf-8');

  // Parse raw (no env substitution) — this is what we write back to disk
  const rawParsed = ModelsConfigSchema.parse(parseConfigContent(content, configPath));
  // Parse resolved (with env substitution) — this is what runtime uses
  const resolvedParsed = ModelsConfigSchema.parse(parseConfigContent(substituteEnvVars(content), configPath));

  // Auto-migrate old format (default = object) to new format (default = string pointer)
  // Migrate both raw and resolved configs identically
  let migrated = false;
  migrated = migrateSection(rawParsed.llm) || migrated;
  migrated = migrateSection(rawParsed.embeddings) || migrated;
  migrateSection(resolvedParsed.llm);
  migrateSection(resolvedParsed.embeddings);

  // Migrate old `p2p` field to `share`
  migrated = migrateP2pToShare(rawParsed.llm) || migrated;
  migrateP2pToShare(resolvedParsed.llm);
  if (rawParsed.image) {
    migrated = migrateP2pToShare(rawParsed.image) || migrated;
    migrateP2pToShare(resolvedParsed.image || {});
  }
  if (rawParsed.tts) {
    migrated = migrateP2pToShare(rawParsed.tts) || migrated;
    migrateP2pToShare(resolvedParsed.tts || {});
  }

  rawConfig = rawParsed;
  loadedConfig = resolvedParsed;
  loadedConfigPath = configPath;

  if (migrated) {
    logger.info('[ModelsConfig] Migrated config (pointer format / p2p→share)');
    // Write the RAW config (preserves ${...} env var references) as YAML
    await fs.writeFile(configPath, stringifyYaml(rawParsed, { lineWidth: 0 }));
  }

  logger.info(`[ModelsConfig] Loaded ${Object.keys(resolvedParsed.llm).length} model(s), ${Object.keys(resolvedParsed.embeddings).length} embedding(s)`);

  return resolvedParsed;
}

export function getModelConfig(name: string): ModelConfig {
  if (!loadedConfig) {
    throw new Error('LLM config not loaded. Call loadModelsConfig() first.');
  }

  let config = loadedConfig.llm[name];
  // Dereference string pointer (one level)
  if (typeof config === 'string') {
    config = loadedConfig.llm[config];
  }
  if (!config || typeof config === 'string') {
    const available = Object.keys(loadedConfig.llm).filter(k => typeof loadedConfig!.llm[k] !== 'string').join(', ');
    throw new Error(`Model config "${name}" not found. Available: ${available}`);
  }

  return config;
}

export function getEmbeddingConfig(name: string): EmbeddingModelConfig {
  if (!loadedConfig) {
    throw new Error('LLM config not loaded. Call loadModelsConfig() first.');
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
export function resolveDefaultName(section: 'llm' | 'embeddings' | 'image' | 'video' | 'tts', name: string = 'default'): string {
  if (!loadedConfig) return name;
  const sectionData = loadedConfig[section];
  if (!sectionData) return name;
  const val = sectionData[name];
  if (typeof val === 'string') return val;
  return name;
}

export function listModelConfigs(): string[] {
  if (!loadedConfig) {
    return [];
  }
  // Filter out string pointers — only return concrete config entries
  return Object.keys(loadedConfig.llm).filter(k => typeof loadedConfig!.llm[k] !== 'string');
}

export function listEmbeddingConfigs(): string[] {
  if (!loadedConfig) {
    return [];
  }
  return Object.keys(loadedConfig.embeddings).filter(k => typeof loadedConfig!.embeddings[k] !== 'string');
}

export function isModelsConfigLoaded(): boolean {
  return loadedConfig !== null;
}

export function getModelsConfig(): ModelsConfig | null {
  return loadedConfig;
}

export function getModelsConfigPath(): string | null {
  return loadedConfigPath;
}

/**
 * Sync changes from the resolved runtime config into rawConfig,
 * preserving ${...} env var references in apiKey fields.
 */
function syncToRaw(config: ModelsConfig): void {
  if (!rawConfig) {
    rawConfig = structuredClone(config);
    return;
  }

  for (const section of ['llm', 'embeddings'] as const) {
    const rawSection = rawConfig[section];
    const newSection = config[section];

    // Remove keys that were deleted
    for (const key of Object.keys(rawSection)) {
      if (!(key in newSection)) delete rawSection[key];
    }

    // Add/update keys
    for (const [key, value] of Object.entries(newSection)) {
      if (typeof value === 'string') {
        // String pointer (e.g. "default": "llama-cpp")
        rawSection[key] = value;
      } else {
        const rawEntry = rawSection[key];
        if (rawEntry && typeof rawEntry === 'object') {
          // Existing entry — preserve ${...} apiKey reference
          const rawApiKey = (rawEntry as any).apiKey;
          rawSection[key] = { ...value };
          if (rawApiKey && typeof rawApiKey === 'string' && rawApiKey.includes('${')) {
            (rawSection[key] as any).apiKey = rawApiKey;
          }
        } else {
          // New entry — write as-is
          rawSection[key] = { ...value };
        }
      }
    }
  }

  // Sync top-level fields
  rawConfig.version = config.version;
  rawConfig.engineUrls = config.engineUrls ? { ...config.engineUrls } : undefined;
  rawConfig.image = config.image ? structuredClone(config.image) : undefined;
  rawConfig.video = config.video ? structuredClone(config.video) : undefined;
  rawConfig.tts = config.tts ? structuredClone(config.tts) : undefined;
}

export async function saveModelsConfig(configPath: string, config: ModelsConfig): Promise<void> {
  syncToRaw(config);
  await fs.writeFile(configPath, stringifyYaml(rawConfig, { lineWidth: 0 }));
  loadedConfig = config;
  logger.info(`[ModelsConfig] Saved config with ${Object.keys(config.llm).length} model(s), ${Object.keys(config.embeddings).length} embedding(s)`);
}

export function getImageConfig(name: string): ImageModelConfig | undefined {
  if (!loadedConfig?.image) return undefined;
  let config = loadedConfig.image[name];
  if (typeof config === 'string') config = loadedConfig.image[config];
  if (!config || typeof config === 'string') return undefined;
  return config;
}

export function getTtsConfig(name: string): TtsModelConfig | undefined {
  if (!loadedConfig?.tts) return undefined;
  let config = loadedConfig.tts[name];
  if (typeof config === 'string') config = loadedConfig.tts[config];
  if (!config || typeof config === 'string') return undefined;
  return config;
}

export function listImageConfigs(): Array<{ name: string; config: ImageModelConfig }> {
  if (!loadedConfig?.image) return [];
  return Object.entries(loadedConfig.image)
    .filter((e): e is [string, ImageModelConfig] => typeof e[1] !== 'string')
    .map(([name, config]) => ({ name, config }));
}

export function listTtsConfigs(): Array<{ name: string; config: TtsModelConfig }> {
  if (!loadedConfig?.tts) return [];
  return Object.entries(loadedConfig.tts)
    .filter((e): e is [string, TtsModelConfig] => typeof e[1] !== 'string')
    .map(([name, config]) => ({ name, config }));
}

export function listVideoConfigs(): Array<{ name: string; config: VideoModelConfig }> {
  if (!loadedConfig?.video) return [];
  return Object.entries(loadedConfig.video)
    .filter((e): e is [string, VideoModelConfig] => typeof e[1] !== 'string')
    .map(([name, config]) => ({ name, config }));
}

export function getVideoConfig(name: string): VideoModelConfig {
  if (!loadedConfig?.video) throw new Error('No video models configured');
  let config = loadedConfig.video[name];
  if (typeof config === 'string') config = loadedConfig.video[config];
  if (!config || typeof config === 'string') {
    const available = Object.keys(loadedConfig.video).filter(k => typeof loadedConfig!.video![k] !== 'string').join(', ');
    throw new Error(`Video model "${name}" not found. Available: ${available}`);
  }
  return config;
}
