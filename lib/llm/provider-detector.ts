import type { ModelConfig } from './llm-config.js';

export type LLMProvider = 'openai' | 'gemini' | 'anthropic' | 'local';

/**
 * Detects which LLM provider to use based on configuration
 * Priority:
 * 1. Explicit provider field
 * 2. Auto-detect from baseUrl
 * 3. Auto-detect from model name
 * 4. Default to 'openai' for backwards compatibility
 */
export function detectProvider(config: ModelConfig): LLMProvider {
  // 1. Explicit provider field takes precedence
  if (config.provider) {
    return config.provider;
  }

  // 2. Auto-detect from baseUrl
  if (config.baseUrl) {
    if (config.baseUrl.includes('api.openai.com')) {
      return 'openai';
    }
    if (config.baseUrl.includes('generativelanguage.googleapis.com')) {
      // Check if using OpenAI-compatible endpoint
      if (config.baseUrl.includes('/openai/')) {
        return 'local'; // Treat OpenAI-compatible Gemini as local
      }
      return 'gemini'; // Native Google API
    }
    if (config.baseUrl.includes('api.anthropic.com')) {
      return 'anthropic';
    }
    // Any other baseUrl is assumed to be an OpenAI-compatible local server
    return 'local';
  }

  // 3. Auto-detect from model name patterns
  const modelLower = config.model.toLowerCase();
  if (modelLower.startsWith('gpt-')) {
    return 'openai';
  }
  if (modelLower.startsWith('gemini-')) {
    return 'gemini';
  }
  if (modelLower.startsWith('claude-')) {
    return 'anthropic';
  }

  // 4. Default to openai for backwards compatibility
  return 'openai';
}
