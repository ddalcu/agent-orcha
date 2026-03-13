import { OpenAIChatModel } from './providers/openai-chat-model.ts';
import { AnthropicChatModel } from './providers/anthropic-chat-model.ts';
import { GeminiChatModel } from './providers/gemini-chat-model.ts';
import type { ChatModel } from '../types/llm-types.ts';
import { getModelConfig, getLLMConfig, getLLMConfigPath, saveLLMConfig, resolveApiKey, type ModelConfig } from './llm-config.ts';
import { resolveAgentLLMRef, type AgentLLMRef } from './types.ts';
import { detectProvider, type LLMProvider } from './provider-detector.ts';
import { engineRegistry } from '../local-llm/engine-registry.ts';
import { logger } from '../logger.ts';

export class LLMFactory {
  private static instances: Map<string, ChatModel> = new Map();

  /**
   * Create an LLM instance from a config name (defined in llm.json)
   * @param ref - Config name as string, or object with name and optional temperature override
   */
  static async create(ref: AgentLLMRef = 'default'): Promise<ChatModel> {
    const { name, temperature: tempOverride } = resolveAgentLLMRef(ref);
    const config = getModelConfig(name);
    const provider = detectProvider(config);

    // Apply temperature override if provided, otherwise use config temperature
    const temperature = tempOverride ?? config.temperature;
    const key = this.getCacheKey(name, temperature ?? 0);

    const cached = this.instances.get(key);
    if (cached) {
      return cached;
    }

    // Auto-start local engine if needed (skip if user provides their own baseUrl)
    if (provider === 'local' && !config.baseUrl) {
      const engineName = config.engine ?? 'llama-cpp';
      const engine = engineRegistry.getEngine(engineName);
      if (!engine) throw new Error(`Unknown local engine: ${engineName}`);

      await engine.ensureRunningChat(config.model, {
        contextSize: config.contextSize,
        reasoningBudget: config.reasoningBudget,
      });

      // Persist auto-detected contextSize to llm.json
      if (!config.contextSize) {
        const detectedCtx = engine.getChatStatus().contextSize;
        if (detectedCtx) {
          config.contextSize = detectedCtx;
          const fullConfig = getLLMConfig();
          const configPath = getLLMConfigPath();
          if (fullConfig && configPath) {
            await saveLLMConfig(configPath, fullConfig);
          }
        }
      }
    }

    logger.info(`[LLMFactory] Creating LLM: ${name} (provider: ${provider}, model: ${config.model}, temp: ${temperature ?? 'default'})`);

    let llm: ChatModel;
    switch (provider) {
      case 'openai':
        llm = this.createOpenAI(config, temperature);
        break;
      case 'gemini':
        llm = this.createGemini(config, temperature);
        break;
      case 'anthropic':
        llm = this.createAnthropic(config, temperature);
        break;
      case 'local':
        llm = this.createOpenAI(config, temperature, 'local');
        break;
      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }

    this.instances.set(key, llm);
    return llm;
  }

  private static createOpenAI(config: ModelConfig, temperature?: number, provider: LLMProvider = 'openai'): ChatModel {
    const apiKey = resolveApiKey(provider, config.apiKey);
    let baseURL = config.baseUrl;
    let supportsVision = true;
    if (provider === 'local' && !baseURL) {
      const engineName = config.engine ?? 'llama-cpp';
      const engine = engineRegistry.getEngine(engineName);
      baseURL = (engine?.getChatBaseUrl() ?? 'http://127.0.0.1:9990') + '/v1';
      supportsVision = engine?.getChatStatus().supportsVision ?? false;
    }
    return new OpenAIChatModel({
      modelName: config.model,
      apiKey,
      maxTokens: config.maxTokens ?? (provider === 'local' ? 4096 : undefined),
      streamUsage: true,
      baseURL,
      provider: provider as 'openai' | 'local',
      supportsVision,
      ...(provider === 'local' && config.reasoningBudget ? { reasoningBudget: config.reasoningBudget } : {}),
      ...(config.engine ? { engine: config.engine } : {}),
      ...(config.contextSize ? { contextSize: config.contextSize } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
    });
  }

  private static createGemini(config: ModelConfig, temperature?: number): ChatModel {
    const apiKey = resolveApiKey('gemini', config.apiKey);
    return new GeminiChatModel({
      modelName: config.model,
      apiKey,
      maxTokens: config.maxTokens,
      ...(temperature !== undefined ? { temperature } : {}),
    });
  }

  private static createAnthropic(config: ModelConfig, temperature?: number): ChatModel {
    const apiKey = resolveApiKey('anthropic', config.apiKey);
    return new AnthropicChatModel({
      modelName: config.model,
      apiKey,
      baseURL: config.baseUrl,
      maxTokens: config.maxTokens,
      thinkingBudget: config.thinkingBudget,
      ...(temperature !== undefined ? { temperature } : {}),
    });
  }

  private static getCacheKey(name: string, temperature: number): string {
    return `${name}-${temperature}`;
  }

  static clearCache(): void {
    this.instances.clear();
  }
}
