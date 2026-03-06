import { LlamaServerProcess } from './llama-server-process.ts';
import { ModelManager } from './model-manager.ts';
import { logger } from '../logger.ts';

// ─── Singleton Server Instances ─────────────────────────────────────────────

let chatServer: LlamaServerProcess | null = null;
let embeddingServer: LlamaServerProcess | null = null;

async function resolveModelPath(baseDir: string, modelName: string): Promise<string> {
  const manager = new ModelManager(baseDir);
  const filePath = await manager.findModelFile(modelName);
  if (!filePath) throw new Error(`Local model "${modelName}" not found. Download it first.`);
  return filePath;
}

export const llamaEngine = {
  _baseDir: '',

  setBaseDir(dir: string) { this._baseDir = dir; },

  async load(modelPath: string): Promise<void> {
    if (!chatServer) chatServer = new LlamaServerProcess(this._baseDir);
    if (chatServer.running && chatServer.modelPath === modelPath) return;
    await chatServer.start({ modelPath });
  },

  async unload(): Promise<void> {
    if (chatServer) await chatServer.stop();
  },

  async swap(modelPath: string): Promise<void> {
    await this.unload();
    await this.load(modelPath);
  },

  async ensureRunning(modelName: string): Promise<void> {
    if (chatServer?.running) return;
    logger.info(`[LlamaEngine] Auto-starting chat model: ${modelName}`);
    const filePath = await resolveModelPath(this._baseDir, modelName);
    await this.load(filePath);
  },

  getStatus(): { running: boolean; activeModel: string | null; port: number | null } {
    return {
      running: chatServer?.running ?? false,
      activeModel: chatServer?.modelPath ?? null,
      port: chatServer?.port ?? null,
    };
  },

  getBaseUrl(): string | null {
    return chatServer?.ready ? chatServer.getBaseUrl() : null;
  },
};

export const llamaEmbeddingEngine = {
  _baseDir: '',

  setBaseDir(dir: string) { this._baseDir = dir; },

  async load(modelPath: string): Promise<void> {
    if (!embeddingServer) embeddingServer = new LlamaServerProcess(this._baseDir, true);
    if (embeddingServer.running && embeddingServer.modelPath === modelPath) return;
    await embeddingServer.start({ modelPath, embedding: true });
  },

  async unload(): Promise<void> {
    if (embeddingServer) await embeddingServer.stop();
  },

  async ensureRunning(modelName: string): Promise<void> {
    if (embeddingServer?.running) return;
    logger.info(`[LlamaEngine] Auto-starting embedding model: ${modelName}`);
    const filePath = await resolveModelPath(this._baseDir, modelName);
    await this.load(filePath);
  },

  getStatus(): { running: boolean; activeModel: string | null } {
    return {
      running: embeddingServer?.running ?? false,
      activeModel: embeddingServer?.modelPath ?? null,
    };
  },

  getBaseUrl(): string | null {
    return embeddingServer?.ready ? embeddingServer.getBaseUrl() : null;
  },
};
