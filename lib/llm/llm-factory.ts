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
import type { LeverageMode } from '../agents/types.ts';
import path from 'node:path';
import { resolveModelFile } from '../local-llm/resolve-model-path.ts';
import { ModelManager } from '../local-llm/model-manager.ts';

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
   * @param leverage - P2P leverage mode: false (disabled), 'local-first', 'remote-first', or 'remote-only'
   */
  static async create(ref: AgentModelRef = 'default', leverage: LeverageMode | boolean = false): Promise<ChatModel> {
    const resolved = resolveAgentModelRef(ref);
    const name = resolved.llm;
    const tempOverride = resolved.temperature;

    // Normalize boolean to LeverageMode
    const mode: LeverageMode = leverage === true ? 'local-first' : leverage;

    // remote-first: try P2P before local
    if (mode === 'remote-first' && this.p2pManager) {
      const remoteModels = this.p2pManager.getRemoteModelsByName(name, 'chat');
      if (remoteModels.length > 0) {
        const match = this.p2pManager.selectBestPeer(remoteModels);
        logger.info(`[LLMFactory] P2P remote-first: using ${match.model} from ${match.peerName}`);
        return new P2PChatModel(this.p2pManager, match.peerId, match.name, tempOverride);
      }
      logger.info(`[LLMFactory] P2P remote-first: no remote peers for "${name}", falling back to local`);
    }

    // remote-only: only use P2P, no local fallback
    if (mode === 'remote-only') {
      if (!this.p2pManager) {
        throw new Error(`Model "${name}" cannot be resolved: leverage is "remote-only" but P2P is not enabled`);
      }
      const remoteModels = this.p2pManager.getRemoteModelsByName(name, 'chat');
      if (remoteModels.length > 0) {
        const match = this.p2pManager.selectBestPeer(remoteModels);
        logger.info(`[LLMFactory] P2P remote-only: using ${match.model} from ${match.peerName}`);
        return new P2PChatModel(this.p2pManager, match.peerId, match.name, tempOverride);
      }
      const available = this.p2pManager.getRemoteModels().map(m => `${m.model} (${m.peerName})`).join(', ');
      throw new Error(`Model "${name}" not found on P2P network (remote-only). Available remote: ${available || 'none'}`);
    }

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

    // Step 3: P2P fallback for local-first mode
    if (!config && mode === 'local-first' && this.p2pManager) {
      const remoteModels = this.p2pManager.getRemoteModelsByName(name, 'chat');
      if (remoteModels.length > 0) {
        const match = this.p2pManager.selectBestPeer(remoteModels);
        logger.info(`[LLMFactory] P2P local-first fallback: using ${match.model} from ${match.peerName}`);
        return new P2PChatModel(this.p2pManager, match.peerId, match.name, tempOverride);
      }
    }

    if (!config) {
      if (mode && this.p2pManager) {
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
      case 'openrouter':
        llm = this.createOpenAI(config, temperature, 'openrouter');
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
    const baseURL = config.baseUrl ?? (provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : undefined);
    const supportsVision = true;
    return new OpenAIChatModel({
      modelName: config.model,
      apiKey,
      maxTokens: config.maxTokens ?? (provider === 'local' ? 4096 : undefined),
      streamUsage: true,
      baseURL,
      provider: provider as 'openai' | 'openrouter' | 'local',
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

    // Auto-detect mmproj for vision models
    let mmprojPath: string | undefined;
    if (this.modelsDir) {
      const workspaceRoot = path.dirname(this.modelsDir); // modelsDir is <workspace>/.models
      const manager = new ModelManager(workspaceRoot);
      const modelFileName = path.basename(modelPath);
      const found = await manager.findMmprojForModel(modelFileName);
      if (found) {
        mmprojPath = found;
        logger.info(`[LLMFactory] Auto-detected mmproj for vision: ${mmprojPath}`);
      }
    }

    return new OmniChatModel({
      modelPath,
      ...(mmprojPath ? { mmprojPath } : {}),
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
