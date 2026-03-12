import * as path from 'path';
import { statSync } from 'fs';
import { LlamaServerProcess } from './llama-server-process.ts';
import { MlxServerProcess } from './mlx-server-process.ts';
import { ModelManager } from './model-manager.ts';
import { readGGUFModelInfo, calculateOptimalContextSize, kvCacheBytesPerToken } from './gguf-reader.ts';
import { detectGpu, type GpuInfo } from './binary-manager.ts';
import { logger } from '../logger.ts';

export type EngineType = 'llama' | 'mlx' | null;

// ─── Singleton Server Instances ─────────────────────────────────────────────

let chatServer: LlamaServerProcess | null = null;
let mlxServer: MlxServerProcess | null = null;
let embeddingServer: LlamaServerProcess | null = null;
let mlxEmbeddingServer: MlxServerProcess | null = null;

function detectModelType(modelPath: string): 'gguf' | 'mlx' {
  try {
    return statSync(modelPath).isDirectory() ? 'mlx' : 'gguf';
  } catch {
    return modelPath.endsWith('.gguf') ? 'gguf' : 'mlx';
  }
}

async function resolveModelPath(baseDir: string, modelName: string): Promise<{ filePath: string; type: 'gguf' | 'mlx' }> {
  const manager = new ModelManager(baseDir);
  const result = await manager.findModelFile(modelName);
  if (!result) throw new Error(`Local model "${modelName}" not found. Download it first.`);
  return result;
}

export const llamaEngine = {
  _baseDir: '',
  _engineType: null as EngineType,

  setBaseDir(dir: string) { this._baseDir = dir; },

  _detectedContextSize: null as number | null,
  _memoryEstimate: null as { modelBytes: number; kvCacheBytes: number; totalBytes: number } | null,
  _supportsVision: false,

  async load(modelPath: string, opts?: { contextSize?: number; reasoningBudget?: number }): Promise<void> {
    const modelType = detectModelType(modelPath);

    if (modelType === 'mlx') {
      // MLX path: use MlxServerProcess
      if (mlxServer?.running && mlxServer.modelPath === modelPath) return;
      if (!mlxServer) mlxServer = new MlxServerProcess(this._baseDir);

      // Stop llama server if it was running
      if (chatServer?.running) await chatServer.stop();

      this._memoryEstimate = null;
      this._supportsVision = false;
      this._detectedContextSize = opts?.contextSize ?? null;
      this._engineType = 'mlx';

      await mlxServer.start({ modelPath, contextSize: opts?.contextSize, reasoningBudget: opts?.reasoningBudget });

      // Fetch /props from mlx-serve to get memory usage and context size
      try {
        const baseUrl = mlxServer.getBaseUrl();
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
        logger.warn('[LlamaEngine] Failed to fetch MLX /props:', err);
      }

      return;
    }

    // GGUF path: existing llama-server behavior
    if (!chatServer) chatServer = new LlamaServerProcess(this._baseDir);
    if (chatServer.running && chatServer.modelPath === modelPath) return;

    // Stop mlx server if it was running
    if (mlxServer?.running) await mlxServer.stop();

    let contextSize = opts?.contextSize;

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
    this._engineType = 'llama';
    const gpu = detectGpu();
    const isGpu = gpu.accel !== 'none';
    const isMetal = gpu.accel === 'metal';
    await chatServer.start({
      modelPath,
      contextSize,
      mmproj: mmproj ?? undefined,
      gpuLayers: isGpu ? -1 : 0,
      flashAttn: isGpu,
      ...(isGpu ? { batchSize: 4096, ubatchSize: 1024 } : {}),
      ...(isMetal ? { cacheTypeK: 'q8_0', cacheTypeV: 'q8_0', mlock: true } : {}),
      ...(opts?.reasoningBudget !== undefined ? { reasoningBudget: opts.reasoningBudget } : {}),
    });
  },

  async unload(): Promise<void> {
    if (this._engineType === 'mlx' && mlxServer) {
      await mlxServer.stop();
    } else if (chatServer) {
      await chatServer.stop();
    }
    this._engineType = null;
  },

  async swap(modelPath: string, opts?: { contextSize?: number; reasoningBudget?: number }): Promise<void> {
    await this.unload();
    await this.load(modelPath, opts);
  },

  async ensureRunning(modelName: string, opts?: { contextSize?: number; reasoningBudget?: number }): Promise<void> {
    if (this._engineType === 'mlx' && mlxServer?.running) return;
    if (this._engineType === 'llama' && chatServer?.running) return;
    logger.info(`[LlamaEngine] Auto-starting chat model: ${modelName}`);
    const { filePath } = await resolveModelPath(this._baseDir, modelName);
    await this.load(filePath, opts);
  },

  getStatus(): { running: boolean; activeModel: string | null; port: number | null; contextSize: number | null; memoryEstimate: { modelBytes: number; kvCacheBytes: number; totalBytes: number } | null; gpu: GpuInfo; supportsVision: boolean; engineType: EngineType } {
    const isRunning = (this._engineType === 'mlx' ? mlxServer?.running : chatServer?.running) ?? false;
    const activeModel = (this._engineType === 'mlx' ? mlxServer?.modelPath : chatServer?.modelPath) ?? null;
    const port = (this._engineType === 'mlx' ? mlxServer?.port : chatServer?.port) ?? null;
    return {
      running: isRunning,
      activeModel,
      port,
      contextSize: this._detectedContextSize,
      memoryEstimate: this._memoryEstimate,
      gpu: detectGpu(),
      supportsVision: this._supportsVision,
      engineType: this._engineType,
    };
  },

  getBaseUrl(): string | null {
    if (this._engineType === 'mlx') {
      return mlxServer?.ready ? mlxServer.getBaseUrl() : null;
    }
    return chatServer?.ready ? chatServer.getBaseUrl() : null;
  },
};

const EMBEDDING_UBATCH_SIZES = [8192, 4096, 2048, 1024] as const;

export const llamaEmbeddingEngine = {
  _baseDir: '',
  _engineType: null as EngineType,
  _currentUbatchSize: null as number | null,

  setBaseDir(dir: string) { this._baseDir = dir; },

  getUbatchSize(): number | null { return this._currentUbatchSize; },

  async load(modelPath: string): Promise<void> {
    const modelType = detectModelType(modelPath);

    if (modelType === 'mlx') {
      // MLX embedding model gets its own dedicated server instance
      if (mlxEmbeddingServer?.running && mlxEmbeddingServer.modelPath === modelPath) return;
      if (!mlxEmbeddingServer) mlxEmbeddingServer = new MlxServerProcess(this._baseDir, 'embedding');

      this._engineType = 'mlx';
      this._currentUbatchSize = null;
      await mlxEmbeddingServer.start({ modelPath });
      logger.info(`[LlamaEngine] MLX embedding server ready on port ${mlxEmbeddingServer.port}`);
      return;
    }

    // GGUF path: try descending ubatch sizes until one works
    this._engineType = 'llama';
    if (!embeddingServer) embeddingServer = new LlamaServerProcess(this._baseDir, true);
    if (embeddingServer.running && embeddingServer.modelPath === modelPath) return;

    for (let i = 0; i < EMBEDDING_UBATCH_SIZES.length; i++) {
      const ubatch = EMBEDDING_UBATCH_SIZES[i]!;
      try {
        await embeddingServer.start({ modelPath, embedding: true, batchSize: ubatch, ubatchSize: ubatch });
        this._currentUbatchSize = ubatch;
        if (i > 0) {
          logger.warn(`[LlamaEngine] Embedding server started with reduced batch size: ${ubatch} (default ${EMBEDDING_UBATCH_SIZES[0]} was too large for available GPU resources)`);
        }
        return;
      } catch (err) {
        const isLast = i === EMBEDDING_UBATCH_SIZES.length - 1;
        if (isLast) {
          this._currentUbatchSize = null;
          throw new Error(
            `Embedding server failed to start at all batch sizes (tried: ${EMBEDDING_UBATCH_SIZES.join(', ')}). ` +
            `Insufficient GPU/system resources. Original error: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        logger.warn(`[LlamaEngine] Embedding server failed to start with ubatch=${ubatch}, trying ${EMBEDDING_UBATCH_SIZES[i + 1]}...`);
      }
    }
  },

  async unload(): Promise<void> {
    if (this._engineType === 'mlx' && mlxEmbeddingServer) {
      await mlxEmbeddingServer.stop();
    } else if (embeddingServer) {
      await embeddingServer.stop();
    }
    this._engineType = null;
  },

  async ensureRunning(modelName: string): Promise<void> {
    // Check if the server is actually healthy, not just the flag
    if (this._engineType === 'mlx' && mlxEmbeddingServer?.running && mlxEmbeddingServer?.ready) {
      if (await this._healthCheck()) return;
      logger.warn('[LlamaEngine] Embedding server flagged as ready but health check failed, restarting...');
    }
    if (this._engineType === 'llama' && embeddingServer?.running && embeddingServer?.ready) {
      if (await this._healthCheck()) return;
      logger.warn('[LlamaEngine] Embedding server flagged as ready but health check failed, restarting...');
    }
    logger.info(`[LlamaEngine] Auto-starting embedding model: ${modelName}`);
    const { filePath } = await resolveModelPath(this._baseDir, modelName);
    await this.load(filePath);
  },

  async _healthCheck(): Promise<boolean> {
    const url = this.getBaseUrl();
    if (!url) return false;
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const body: any = await res.json();
        return body.status === 'ok';
      }
    } catch { /* server not reachable */ }
    return false;
  },

  getStatus(): { running: boolean; activeModel: string | null } {
    if (this._engineType === 'mlx') {
      return {
        running: mlxEmbeddingServer?.running ?? false,
        activeModel: mlxEmbeddingServer?.modelPath ?? null,
      };
    }
    return {
      running: embeddingServer?.running ?? false,
      activeModel: embeddingServer?.modelPath ?? null,
    };
  },

  getBaseUrl(): string | null {
    if (this._engineType === 'mlx') {
      return mlxEmbeddingServer?.ready ? mlxEmbeddingServer.getBaseUrl() : null;
    }
    return embeddingServer?.ready ? embeddingServer.getBaseUrl() : null;
  },
};
