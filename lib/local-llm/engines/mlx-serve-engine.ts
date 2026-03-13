import { MlxServerProcess } from '../mlx-server-process.ts';
import { killOrphanedMlxServers } from '../mlx-server-process.ts';
import { ModelManager } from '../model-manager.ts';
import { getMlxBinaryVersion, isMlxSystemBinary, updateMlxBinary, checkForMlxUpdate } from '../mlx-binary-manager.ts';
import { logger } from '../../logger.ts';
import type { LocalEngine, EngineChatStatus, EngineServerStatus, EngineStatus, LoadOptions } from '../engine-interface.ts';

export class MlxServeEngine implements LocalEngine {
  readonly engineName = 'mlx-serve';

  private _baseDir = '';
  private chatServer: MlxServerProcess | null = null;
  private embeddingServer: MlxServerProcess | null = null;
  private _detectedContextSize: number | null = null;
  private _memoryEstimate: { modelBytes: number; kvCacheBytes: number; totalBytes: number } | null = null;
  private _supportsVision = false;

  setBaseDir(dir: string): void {
    this._baseDir = dir;
  }

  isAvailable(): boolean {
    return getMlxBinaryVersion(this._baseDir) !== null && process.platform === 'darwin' && process.arch === 'arm64';
  }

  // ─── Chat ───────────────────────────────────────────────────────────────────

  async loadChat(modelPath: string, opts?: LoadOptions): Promise<void> {
    if (this.chatServer?.running && this.chatServer.modelPath === modelPath) return;
    if (!this.chatServer) this.chatServer = new MlxServerProcess(this._baseDir);

    this._memoryEstimate = null;
    this._supportsVision = false;
    this._detectedContextSize = opts?.contextSize ?? null;

    await this.chatServer.start({ modelPath, contextSize: opts?.contextSize, reasoningBudget: opts?.reasoningBudget });

    // Fetch /props from mlx-serve to get memory usage and context size
    try {
      const baseUrl = this.chatServer.getBaseUrl();
      const res = await fetch(`${baseUrl}/props`);
      if (res.ok) {
        const props = await res.json() as any;
        const nCtx = props.default_generation_settings?.n_ctx;
        if (nCtx && !this._detectedContextSize) {
          this._detectedContextSize = nCtx;
        }
        const ctxSize = this._detectedContextSize ?? nCtx ?? 0;
        const info = props.model_info;
        // KV cache: layers × 2(K+V) × kv_heads × head_dim × 2(float16) × ctx
        const kvCacheBytes = info
          ? info.num_hidden_layers * 2 * info.num_key_value_heads * info.head_dim * 2 * ctxSize
          : 0;
        const modelBytes = props.memory?.active_bytes ?? 0;
        if (modelBytes || kvCacheBytes) {
          this._memoryEstimate = {
            modelBytes,
            kvCacheBytes,
            totalBytes: modelBytes + kvCacheBytes,
          };
        }
      }
    } catch (err) {
      logger.warn('[MlxServeEngine] Failed to fetch /props:', err);
    }
  }

  async unloadChat(): Promise<void> {
    if (this.chatServer) {
      await this.chatServer.stop();
    }
  }

  async swapChat(modelPath: string, opts?: LoadOptions): Promise<void> {
    await this.unloadChat();
    await this.loadChat(modelPath, opts);
  }

  async ensureRunningChat(modelName: string, opts?: LoadOptions): Promise<void> {
    if (this.chatServer?.running) return;
    logger.info(`[MlxServeEngine] Auto-starting chat model: ${modelName}`);
    const { filePath } = await this.resolveModelPath(modelName);
    await this.loadChat(filePath, opts);
  }

  getChatStatus(): EngineChatStatus {
    const running = this.chatServer?.running ?? false;
    return {
      running,
      activeModel: running ? (this.chatServer?.modelPath ?? null) : null,
      port: this.chatServer?.port ?? null,
      contextSize: this._detectedContextSize,
      memoryEstimate: this._memoryEstimate,
      supportsVision: this._supportsVision,
      mmprojBytes: 0,
    };
  }

  getChatBaseUrl(): string | null {
    return this.chatServer?.ready ? this.chatServer.getBaseUrl() : null;
  }

  // ─── Embedding ──────────────────────────────────────────────────────────────

  async loadEmbedding(modelPath: string): Promise<void> {
    if (this.embeddingServer?.running && this.embeddingServer.modelPath === modelPath) return;
    if (!this.embeddingServer) this.embeddingServer = new MlxServerProcess(this._baseDir, 'embedding');

    await this.embeddingServer.start({ modelPath });
    logger.info(`[MlxServeEngine] Embedding server ready on port ${this.embeddingServer.port}`);
  }

  async unloadEmbedding(): Promise<void> {
    if (this.embeddingServer) {
      await this.embeddingServer.stop();
    }
  }

  async ensureRunningEmbedding(modelName: string): Promise<void> {
    if (this.embeddingServer?.running) return;
    logger.info(`[MlxServeEngine] Auto-starting embedding model: ${modelName}`);
    const { filePath } = await this.resolveModelPath(modelName);
    await this.loadEmbedding(filePath);
  }

  getEmbeddingStatus(): EngineServerStatus {
    const running = this.embeddingServer?.running ?? false;
    return {
      running,
      activeModel: running ? (this.embeddingServer?.modelPath ?? null) : null,
      port: this.embeddingServer?.port ?? null,
      contextSize: null,
      memoryEstimate: null,
    };
  }

  getEmbeddingBaseUrl(): string | null {
    return this.embeddingServer?.ready ? this.embeddingServer.getBaseUrl() : null;
  }

  // ─── Combined ───────────────────────────────────────────────────────────────

  getStatus(): EngineStatus {
    return {
      engineName: this.engineName,
      available: this.isAvailable(),
      chat: this.getChatStatus(),
      embedding: this.getEmbeddingStatus(),
    };
  }

  killOrphans(): void {
    killOrphanedMlxServers(this._baseDir);
  }

  // ─── Binary management ─────────────────────────────────────────────────────

  getBinaryVersion(): string | null {
    return getMlxBinaryVersion(this._baseDir);
  }

  getBinarySource(): 'managed' | 'system' | null {
    const version = getMlxBinaryVersion(this._baseDir);
    if (!version) return null;
    return isMlxSystemBinary() ? 'system' : 'managed';
  }

  async checkForUpdate(): Promise<any> {
    return checkForMlxUpdate(this._baseDir);
  }

  async updateBinary(): Promise<void> {
    return updateMlxBinary(this._baseDir);
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private async resolveModelPath(modelName: string): Promise<{ filePath: string; type: 'gguf' | 'mlx' }> {
    const manager = new ModelManager(this._baseDir);
    const result = await manager.findModelFile(modelName);
    if (!result) throw new Error(`Local model "${modelName}" not found. Download it first.`);
    return result;
  }
}
