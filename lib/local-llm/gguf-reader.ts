import * as fs from 'fs/promises';
import * as os from 'os';
import { logger } from '../logger.ts';

const GGUF_MAGIC = 0x46554747; // "GGUF" in little-endian
const METADATA_BUFFER_SIZE = 1024 * 1024; // 1MB covers metadata for all models
const OS_RESERVED_BYTES = 4 * 1024 * 1024 * 1024; // Reserve 4GB for OS + apps
// Reserve for: display driver/framebuffer (~300MB) + CUDA compute buffer (~500MB) + misc overhead
const VRAM_RESERVED_BYTES = 1280 * 1024 * 1024;

export interface GGUFModelInfo {
  contextLength: number;
  blockCount: number;
  embeddingLength: number;
  headCount: number;
  headCountKv: number;
  fileSizeBytes: number;
  /** Every Nth layer is a full attention layer; 0 means all layers are attention (pure transformer). */
  fullAttentionInterval: number;
  /** SSM recurrent state size (d_state). 0 for pure attention models. */
  ssmStateSize: number;
  /** SSM inner dimension (d_inner). 0 for pure attention models. */
  ssmInnerSize: number;
}

/**
 * Reads model architecture info from a GGUF file's metadata header.
 * Only reads the first 1MB — no model loading required.
 */
export async function readGGUFModelInfo(modelPath: string): Promise<GGUFModelInfo | null> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(modelPath, 'r');
    const stat = await handle.stat();
    const buf = Buffer.alloc(METADATA_BUFFER_SIZE);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    if (bytesRead < 24) return null;

    const magic = buf.readUInt32LE(0);
    if (magic !== GGUF_MAGIC) return null;

    const version = buf.readUInt32LE(4);
    if (version < 2 || version > 3) return null;

    const kvCount = Number(buf.readBigUInt64LE(16));
    let pos = 24;

    const info: Partial<GGUFModelInfo> = {
      fileSizeBytes: stat.size,
      fullAttentionInterval: 0,
      ssmStateSize: 0,
      ssmInnerSize: 0,
    };
    const needed = new Set([
      'context_length', 'block_count', 'embedding_length',
      'attention.head_count', 'attention.head_count_kv',
      'full_attention_interval', 'ssm.state_size', 'ssm.inner_size',
    ]);

    for (let i = 0; i < kvCount && pos < bytesRead - 12 && needed.size > 0; i++) {
      if (pos + 8 > bytesRead) break;
      const keyLen = Number(buf.readBigUInt64LE(pos));
      pos += 8;

      if (pos + keyLen > bytesRead) break;
      const key = buf.toString('utf-8', pos, pos + keyLen);
      pos += keyLen;

      if (pos + 4 > bytesRead) break;
      const vtype = buf.readUInt32LE(pos);
      pos += 4;

      if (key.endsWith('.context_length')) {
        info.contextLength = readScalar(buf, pos, vtype) ?? 0;
        needed.delete('context_length');
      } else if (key.endsWith('.block_count')) {
        info.blockCount = readScalar(buf, pos, vtype) ?? 0;
        needed.delete('block_count');
      } else if (key.endsWith('.embedding_length')) {
        info.embeddingLength = readScalar(buf, pos, vtype) ?? 0;
        needed.delete('embedding_length');
      } else if (key.endsWith('.attention.head_count_kv')) {
        info.headCountKv = readScalar(buf, pos, vtype) ?? 0;
        needed.delete('attention.head_count_kv');
      } else if (key.endsWith('.attention.head_count')) {
        info.headCount = readScalar(buf, pos, vtype) ?? 0;
        needed.delete('attention.head_count');
      } else if (key.endsWith('.full_attention_interval')) {
        info.fullAttentionInterval = readScalar(buf, pos, vtype) ?? 0;
        needed.delete('full_attention_interval');
      } else if (key.endsWith('.ssm.state_size')) {
        info.ssmStateSize = readScalar(buf, pos, vtype) ?? 0;
        needed.delete('ssm.state_size');
      } else if (key.endsWith('.ssm.inner_size')) {
        info.ssmInnerSize = readScalar(buf, pos, vtype) ?? 0;
        needed.delete('ssm.inner_size');
      }

      pos = skipValue(buf, pos, vtype, bytesRead);
      if (pos < 0) break;
    }

    if (!info.contextLength) return null;

    const result = info as GGUFModelInfo;
    const isHybrid = result.fullAttentionInterval > 0;
    const attnLayers = isHybrid ? Math.ceil(result.blockCount / result.fullAttentionInterval) : result.blockCount;
    logger.info(`[GGUFReader] ${modelPath.split('/').pop()}: ctx=${result.contextLength} layers=${result.blockCount} attn_layers=${attnLayers} embd=${result.embeddingLength} heads=${result.headCount} kv_heads=${result.headCountKv} size=${(result.fileSizeBytes / 1024 / 1024 / 1024).toFixed(1)}GB${isHybrid ? ` hybrid(interval=${result.fullAttentionInterval})` : ''}`);
    return result;
  } catch (err) {
    logger.warn(`[GGUFReader] Failed to read GGUF metadata: ${err}`);
    return null;
  } finally {
    await handle?.close();
  }
}

/**
 * Estimates KV cache bytes per token for a model.
 * For hybrid SSM+Attention models, only attention layers have a KV cache that
 * scales with context length. SSM layers use a fixed-size recurrent state instead.
 * KV cache = 2 (K+V) * n_attn_layers * n_kv_heads * head_dim * 2 bytes (f16)
 */
export function kvCacheBytesPerToken(info: GGUFModelInfo): number {
  const headDim = info.embeddingLength / info.headCount;
  const attnLayers = info.fullAttentionInterval > 0
    ? Math.ceil(info.blockCount / info.fullAttentionInterval)
    : info.blockCount;
  return 2 * attnLayers * info.headCountKv * headDim * 2;
}

/**
 * Estimates fixed VRAM for SSM recurrent state buffers (context-independent).
 * R (conv state) + S (recurrent state) per SSM layer.
 * Returns 0 for pure attention models.
 */
export function rsFixedBytes(info: GGUFModelInfo): number {
  if (info.fullAttentionInterval === 0 || !info.ssmStateSize || !info.ssmInnerSize) return 0;
  const ssmLayers = info.blockCount - Math.ceil(info.blockCount / info.fullAttentionInterval);
  // S (f32): ssm_d_state * ssm_d_inner * 4 bytes * ssm_layers
  const sBytes = info.ssmStateSize * info.ssmInnerSize * 4 * ssmLayers;
  // R (conv state) is small (~5% of S), add a small buffer
  return Math.round(sBytes * 1.05);
}

/**
 * Calculates optimal context size based on available memory.
 * On macOS (unified memory) or CPU-only systems, uses system RAM.
 * On discrete GPU systems, uses vramBytes so the KV cache stays in VRAM
 * and avoids expensive CPU fallback.
 */
export function calculateOptimalContextSize(info: GGUFModelInfo, vramBytes?: number | null): number {
  // Use VRAM budget on discrete GPU systems; fall back to system RAM otherwise
  // (macOS unified memory, CPU-only, or when VRAM detection fails).
  const memoryPool = vramBytes ?? os.totalmem();
  const reserved = vramBytes ? VRAM_RESERVED_BYTES : OS_RESERVED_BYTES;
  const availableForModel = memoryPool - reserved;
  const memAfterWeights = availableForModel - info.fileSizeBytes;

  if (memAfterWeights <= 0) {
    logger.warn(`[GGUFReader] Model file (${(info.fileSizeBytes / 1024 / 1024 / 1024).toFixed(1)}GB) exceeds available memory, using minimum context`);
    return 2048;
  }

  // Subtract fixed RS buffer cost (SSM recurrent state — context-independent)
  const rsBytes = rsFixedBytes(info);
  const memForKv = memAfterWeights - rsBytes;

  const bytesPerToken = kvCacheBytesPerToken(info);
  const maxCtxByMem = Math.floor(memForKv / bytesPerToken);
  const nativeCtx = info.contextLength;
  const maxNative = Math.floor(nativeCtx * 0.8);

  const optimal = Math.min(maxCtxByMem, maxNative);
  // Floor to nearest 1024 for cleanliness, minimum 2048
  const result = Math.max(2048, Math.floor(optimal / 1024) * 1024);

  const poolLabel = vramBytes ? 'VRAM' : 'RAM';
  logger.info(`[GGUFReader] ${poolLabel}: ${(memoryPool / 1024 / 1024 / 1024).toFixed(0)}GB total, ${(memForKv / 1024 / 1024 / 1024).toFixed(1)}GB for KV | KV/token: ${bytesPerToken} bytes | RS fixed: ${(rsBytes / 1024 / 1024).toFixed(0)}MB | max by ${poolLabel}: ${maxCtxByMem} | max by model (80%): ${maxNative} | optimal: ${result}`);
  return result;
}

function readScalar(buf: Buffer, pos: number, vtype: number): number | null {
  switch (vtype) {
    case 0: return buf.readUInt8(pos);
    case 1: return buf.readInt8(pos);
    case 2: return buf.readUInt16LE(pos);
    case 3: return buf.readInt16LE(pos);
    case 4: return buf.readUInt32LE(pos);
    case 5: return buf.readInt32LE(pos);
    case 6: return buf.readFloatLE(pos);
    case 7: return buf.readUInt8(pos);
    case 10: return Number(buf.readBigUInt64LE(pos));
    case 11: return Number(buf.readBigInt64LE(pos));
    case 12: return buf.readDoubleLE(pos);
    default: return null;
  }
}

function skipValue(buf: Buffer, pos: number, vtype: number, limit: number): number {
  switch (vtype) {
    case 0: case 1: case 7: return pos + 1;
    case 2: case 3: return pos + 2;
    case 4: case 5: case 6: return pos + 4;
    case 10: case 11: case 12: return pos + 8;
    case 8: {
      if (pos + 8 > limit) return -1;
      const len = Number(buf.readBigUInt64LE(pos));
      return pos + 8 + len;
    }
    case 9: {
      if (pos + 12 > limit) return -1;
      const elemType = buf.readUInt32LE(pos);
      const count = Number(buf.readBigUInt64LE(pos + 4));
      pos += 12;
      for (let i = 0; i < count && pos < limit; i++) {
        pos = skipValue(buf, pos, elemType, limit);
        if (pos < 0) return -1;
      }
      return pos;
    }
    default: return -1;
  }
}
