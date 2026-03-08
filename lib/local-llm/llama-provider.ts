import * as path from 'path';
import { LlamaServerProcess } from './llama-server-process.ts';
import { ModelManager } from './model-manager.ts';
import { readGGUFModelInfo, calculateOptimalContextSize, kvCacheBytesPerToken } from './gguf-reader.ts';
import { detectGpu, type GpuInfo } from './binary-manager.ts';
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

  _detectedContextSize: null as number | null,
  _memoryEstimate: null as { modelBytes: number; kvCacheBytes: number; totalBytes: number } | null,
  _supportsVision: false,

  async load(modelPath: string, contextSize?: number): Promise<void> {
    if (!chatServer) chatServer = new LlamaServerProcess(this._baseDir);
    if (chatServer.running && chatServer.modelPath === modelPath) return;

    // Calculate optimal context size from GGUF metadata + available RAM
    const modelInfo = await readGGUFModelInfo(modelPath);
    if (!contextSize && modelInfo) {
      contextSize = calculateOptimalContextSize(modelInfo);
    }

    // Estimate memory usage for status reporting
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

    if (mmproj) {
      logger.info(`[LlamaEngine] Vision enabled with mmproj: ${path.basename(mmproj)}`);
    }

    this._detectedContextSize = contextSize ?? null;
    const gpu = detectGpu();
    const isGpu = gpu.accel !== 'none';
    await chatServer.start({
      modelPath,
      contextSize,
      mmproj: mmproj ?? undefined,
      gpuLayers: isGpu ? -1 : 0,
      flashAttn: isGpu,
      ...(isGpu ? { batchSize: 4096, ubatchSize: 1024 } : {}),
    });
  },

  async unload(): Promise<void> {
    if (chatServer) await chatServer.stop();
  },

  async swap(modelPath: string, contextSize?: number): Promise<void> {
    await this.unload();
    await this.load(modelPath, contextSize);
  },

  async ensureRunning(modelName: string, contextSize?: number): Promise<void> {
    if (chatServer?.running) return;
    logger.info(`[LlamaEngine] Auto-starting chat model: ${modelName}`);
    const filePath = await resolveModelPath(this._baseDir, modelName);
    await this.load(filePath, contextSize);
  },

  getStatus(): { running: boolean; activeModel: string | null; port: number | null; contextSize: number | null; memoryEstimate: { modelBytes: number; kvCacheBytes: number; totalBytes: number } | null; gpu: GpuInfo; supportsVision: boolean } {
    return {
      running: chatServer?.running ?? false,
      activeModel: chatServer?.modelPath ?? null,
      port: chatServer?.port ?? null,
      contextSize: this._detectedContextSize,
      memoryEstimate: this._memoryEstimate,
      gpu: detectGpu(),
      supportsVision: this._supportsVision,
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
