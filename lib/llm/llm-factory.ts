import { OpenAIChatModel } from './providers/openai-chat-model.ts';
import { AnthropicChatModel } from './providers/anthropic-chat-model.ts';
import { GeminiChatModel } from './providers/gemini-chat-model.ts';
import { OmniChatModel } from './providers/omni-chat-model.ts';
import { P2PChatModel } from '../p2p/p2p-chat-model.ts';
import type { ChatModel } from '../types/llm-types.ts';
import { getModelConfig, listModelConfigs, resolveApiKey, type ModelConfig } from './llm-config.ts';
import { resolveAgentModelRef, type AgentModelRef } from './types.ts';
import { detectProvider, type LLMProvider } from './provider-detector.ts';
import { logger } from '../logger.ts';
import type { P2PManager } from '../p2p/p2p-manager.ts';
import { resolveModelFile } from '../local-llm/resolve-model-path.ts';

export class LLMFactory {
  private static instances: Map<string, ChatModel> = new Map();
  private static p2pManager: P2PManager | null = null;
  private static modelsDir: string | null = null;

  static setP2PManager(manager: P2PManager): void {
    this.p2pManager = manager;
  }

  static setModelsDir(dir: string): void {
    this.modelsDir = dir;
  }

  /**
   * Create an LLM instance from a config name (defined in models.yaml)
   * @param ref - Config name as string, or object with name and optional temperature override
   * @param leverage - If true, fall back to P2P network when model not found locally
   */
  static async create(ref: AgentModelRef = 'default', leverage = false): Promise<ChatModel> {
    const resolved = resolveAgentModelRef(ref);
    const name = resolved.llm;
    const tempOverride = resolved.temperature;

    // Step 1: Try exact config key match
    let config: ModelConfig | undefined;
    try {
      config = getModelConfig(name);
    } catch {
      // Not found by config key — try step 2
    }

    // Step 2: Search by model string (case-insensitive partial match)
    if (!config) {
      const allNames = listModelConfigs();
      for (const key of allNames) {
        try {
          const c = getModelConfig(key);
          if (c.model.toLowerCase() === name.toLowerCase() ||
              c.model.toLowerCase().includes(name.toLowerCase())) {
            config = c;
            break;
          }
        } catch {
          // skip unreachable configs
        }
      }
    }

    // Step 3: P2P network (if leverage enabled)
    if (!config && leverage && this.p2pManager) {
      const remoteModels = this.p2pManager.getRemoteModelsByName(name);
      if (remoteModels.length > 0) {
        const match = remoteModels[0]!;
        logger.info(`[LLMFactory] Using P2P model: ${match.model} from ${match.peerName}`);
        const temperature = tempOverride;
        return new P2PChatModel(this.p2pManager, match.peerId, match.name, temperature);
      }
    }

    if (!config) {
      // Build helpful error message
      if (leverage && this.p2pManager) {
        const available = this.p2pManager.getRemoteModels().map(m => `${m.model} (${m.peerName})`).join(', ');
        throw new Error(`Model "${name}" not found locally or on P2P network. Available remote: ${available || 'none'}`);
      }
      throw new Error(`Model "${name}" not found in models config`);
    }

    const provider = detectProvider(config);

    // Apply temperature override if provided, otherwise use config temperature
    const temperature = tempOverride ?? config.temperature;
    const key = this.getCacheKey(name, temperature ?? 0);

    const cached = this.instances.get(key);
    if (cached) {
      return cached;
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
      case 'omni':
        llm = await this.createOmni(config, temperature);
        break;
      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }

    this.instances.set(key, llm);
    return llm;
  }

  private static createOpenAI(config: ModelConfig, temperature?: number, provider: LLMProvider = 'openai'): ChatModel {
    const apiKey = resolveApiKey(provider, config.apiKey);
    const baseURL = config.baseUrl;
    const supportsVision = true;
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

  private static async createOmni(config: ModelConfig, temperature?: number): Promise<ChatModel> {
    // Resolve model path: scan subdirectories in .models/
    let modelPath = config.model;
    if (!modelPath.includes('/') && !modelPath.includes('\\') && this.modelsDir) {
      modelPath = await resolveModelFile(this.modelsDir, modelPath);
    }

    return new OmniChatModel({
      modelPath,
      contextSize: config.contextSize,
      maxTokens: config.maxTokens,
      thinkingBudget: config.thinkingBudget ?? config.reasoningBudget,
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
