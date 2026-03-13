import * as path from 'path';
import * as fs from 'fs/promises';
import { LlamaServerProcess } from '../llama-server-process.ts';
import { killOrphanedServers } from '../llama-server-process.ts';
import { ModelManager } from '../model-manager.ts';
import { readGGUFModelInfo, calculateOptimalContextSize, kvCacheBytesPerToken } from '../gguf-reader.ts';
import { detectGpu, getBinaryVersion, isSystemBinary, updateBinary, checkForUpdate } from '../binary-manager.ts';
import { logger } from '../../logger.ts';
import type { LocalEngine, EngineChatStatus, EngineServerStatus, EngineStatus, LoadOptions } from '../engine-interface.ts';

export class LlamaCppEngine implements LocalEngine {
  readonly engineName = 'llama-cpp';

  private _baseDir = '';
  private chatServer: LlamaServerProcess | null = null;
  private embeddingServer: LlamaServerProcess | null = null;
  private _detectedContextSize: number | null = null;
  private _memoryEstimate: { modelBytes: number; kvCacheBytes: number; totalBytes: number } | null = null;
  private _supportsVision = false;
  private _mmprojBytes = 0;
  private _embeddingModelBytes = 0;

  setBaseDir(dir: string): void {
    this._baseDir = dir;
  }

  isAvailable(): boolean {
    return getBinaryVersion(this._baseDir) !== null;
  }

  // ─── Chat ───────────────────────────────────────────────────────────────────

  async loadChat(modelPath: string, opts?: LoadOptions): Promise<void> {
    if (!this.chatServer) this.chatServer = new LlamaServerProcess(this._baseDir);
    if (this.chatServer.running && this.chatServer.modelPath === modelPath) return;

    let contextSize = opts?.contextSize;

    const modelInfo = await readGGUFModelInfo(modelPath);
    if (!contextSize && modelInfo) {
      contextSize = calculateOptimalContextSize(modelInfo);
    }

    if (modelInfo && contextSize) {
      const kvBytes = contextSize * kvCacheBytesPerToken(modelInfo);
      this._memoryEstimate = {
        modelBytes: modelInfo.fileSizeBytes,
        kvCacheBytes: kvBytes,
        totalBytes: modelInfo.fileSizeBytes + kvBytes,
      };
    }

    // Auto-detect multimodal projector (mmproj) for vision support
    const modelFileName = path.basename(modelPath);
    const manager = new ModelManager(this._baseDir);
    const mmproj = await manager.findMmprojForModel(modelFileName);
    this._supportsVision = !!mmproj;
    this._mmprojBytes = 0;

    if (mmproj) {
      try { this._mmprojBytes = (await fs.stat(mmproj)).size; } catch { /* ignore */ }
      logger.info(`[LlamaCppEngine] Vision enabled with mmproj: ${path.basename(mmproj)} (${(this._mmprojBytes / 1024 / 1024).toFixed(0)}MB)`);
    }

    this._detectedContextSize = contextSize ?? null;
    const gpu = detectGpu();
    const isGpu = gpu.accel !== 'none';
    const isMetal = gpu.accel === 'metal';
    await this.chatServer.start({
      modelPath,
      contextSize,
      mmproj: mmproj ?? undefined,
      gpuLayers: isGpu ? -1 : 0,
      flashAttn: isGpu,
      ...(isGpu ? { batchSize: 4096, ubatchSize: 1024 } : {}),
      ...(isMetal ? { cacheTypeK: 'q8_0', cacheTypeV: 'q8_0', mlock: true } : {}),
      ...(opts?.reasoningBudget !== undefined ? { reasoningBudget: opts.reasoningBudget } : {}),
    });
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
    logger.info(`[LlamaCppEngine] Auto-starting chat model: ${modelName}`);
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
      mmprojBytes: this._mmprojBytes,
    };
  }

  getChatBaseUrl(): string | null {
    return this.chatServer?.ready ? this.chatServer.getBaseUrl() : null;
  }

  // ─── Embedding ──────────────────────────────────────────────────────────────

  async loadEmbedding(modelPath: string): Promise<void> {
    if (!this.embeddingServer) this.embeddingServer = new LlamaServerProcess(this._baseDir, true);
    if (this.embeddingServer.running && this.embeddingServer.modelPath === modelPath) return;
    try { this._embeddingModelBytes = (await fs.stat(modelPath)).size; } catch { this._embeddingModelBytes = 0; }
    await this.embeddingServer.start({ modelPath, embedding: true });
  }

  async unloadEmbedding(): Promise<void> {
    if (this.embeddingServer) {
      await this.embeddingServer.stop();
    }
  }

  async ensureRunningEmbedding(modelName: string): Promise<void> {
    if (this.embeddingServer?.running) return;
    logger.info(`[LlamaCppEngine] Auto-starting embedding model: ${modelName}`);
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
      memoryEstimate: running ? { modelBytes: this._embeddingModelBytes, kvCacheBytes: 0, totalBytes: this._embeddingModelBytes } : null,
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
    killOrphanedServers(this._baseDir);
  }

  // ─── Binary management ─────────────────────────────────────────────────────

  getBinaryVersion(): string | null {
    return getBinaryVersion(this._baseDir);
  }

  getBinarySource(): 'managed' | 'system' | null {
    const version = getBinaryVersion(this._baseDir);
    if (!version) return null;
    return isSystemBinary() ? 'system' : 'managed';
  }

  async checkForUpdate(): Promise<any> {
    return checkForUpdate(this._baseDir);
  }

  async updateBinary(): Promise<void> {
    return updateBinary(this._baseDir);
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private async resolveModelPath(modelName: string): Promise<{ filePath: string; type: 'gguf' | 'mlx' }> {
    const manager = new ModelManager(this._baseDir);
    const result = await manager.findModelFile(modelName);
    if (!result) throw new Error(`Local model "${modelName}" not found. Download it first.`);
    return result;
  }
}
