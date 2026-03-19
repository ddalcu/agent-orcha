import { OpenAIChatModel } from './providers/openai-chat-model.ts';
import { AnthropicChatModel } from './providers/anthropic-chat-model.ts';
import { GeminiChatModel } from './providers/gemini-chat-model.ts';
import { P2PChatModel } from '../p2p/p2p-chat-model.ts';
import type { ChatModel } from '../types/llm-types.ts';
import { getModelConfig, getLLMConfig, getLLMConfigPath, saveLLMConfig, resolveApiKey, type ModelConfig } from './llm-config.ts';
import { resolveAgentLLMRef, type AgentLLMRef } from './types.ts';
import { detectProvider, type LLMProvider } from './provider-detector.ts';
import { engineRegistry } from '../local-llm/engine-registry.ts';
import { logger } from '../logger.ts';
import type { P2PManager } from '../p2p/p2p-manager.ts';

export class LLMFactory {
  private static instances: Map<string, ChatModel> = new Map();
  private static p2pManager: P2PManager | null = null;

  static setP2PManager(manager: P2PManager): void {
    this.p2pManager = manager;
  }

  /**
   * Create an LLM instance from a config name (defined in llm.json)
   * @param ref - Config name as string, or object with name and optional temperature override
   */
  static async create(ref: AgentLLMRef = 'default'): Promise<ChatModel> {
    const { name, temperature: tempOverride } = resolveAgentLLMRef(ref);

    // Handle P2P LLM references: "p2p" or "p2p:model-name"
    if (name === 'p2p' || name.startsWith('p2p:')) {
      return this.createP2P(name, tempOverride);
    }

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

  private static createP2P(ref: string, temperature?: number): ChatModel {
    if (!this.p2pManager) {
      throw new Error('P2P is not enabled. Set P2P_ENABLED=true to use P2P LLMs.');
    }

    const remoteLLMs = this.p2pManager.getRemoteLLMs();
    if (remoteLLMs.length === 0) {
      throw new Error('No remote P2P LLMs available');
    }

    if (ref === 'p2p') {
      // Auto-select first available remote LLM
      const llm = remoteLLMs[0]!;
      logger.info(`[LLMFactory] Auto-selected P2P LLM: ${llm.name} from ${llm.peerName}`);
      return new P2PChatModel(this.p2pManager, llm.peerId, llm.name, temperature);
    }

    // "p2p:model-name" — find by name or model string
    const modelRef = ref.slice(4); // strip "p2p:"
    const match = remoteLLMs.find(l => l.name === modelRef || l.model === modelRef);
    if (!match) {
      const available = remoteLLMs.map(l => l.name).join(', ');
      throw new Error(`P2P LLM "${modelRef}" not found. Available: ${available}`);
    }

    logger.info(`[LLMFactory] Using P2P LLM: ${match.name} from ${match.peerName}`);
    return new P2PChatModel(this.p2pManager, match.peerId, match.name, temperature);
  }

  static clearCache(): void {
    this.instances.clear();
  }
}
