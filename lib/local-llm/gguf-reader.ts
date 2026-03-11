import * as fs from 'fs/promises';
import { readFileSync } from 'fs';
import * as os from 'os';
import { logger } from '../logger.ts';

const GGUF_MAGIC = 0x46554747; // "GGUF" in little-endian
const METADATA_BUFFER_SIZE = 1024 * 1024; // 1MB covers metadata for all models
const OS_RESERVED_BYTES = 4 * 1024 * 1024 * 1024; // Reserve 4GB for OS + apps

export interface GGUFModelInfo {
  contextLength: number;
  blockCount: number;
  embeddingLength: number;
  headCount: number;
  headCountKv: number;
  fileSizeBytes: number;
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

    const info: Partial<GGUFModelInfo> = { fileSizeBytes: stat.size };
    const needed = new Set(['context_length', 'block_count', 'embedding_length', 'attention.head_count', 'attention.head_count_kv']);

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
      }

      pos = skipValue(buf, pos, vtype, bytesRead);
      if (pos < 0) break;
    }

    if (!info.contextLength) return null;

    const result = info as GGUFModelInfo;
    logger.info(`[GGUFReader] ${modelPath.split('/').pop()}: ctx=${result.contextLength} layers=${result.blockCount} embd=${result.embeddingLength} heads=${result.headCount} kv_heads=${result.headCountKv} size=${(result.fileSizeBytes / 1024 / 1024 / 1024).toFixed(1)}GB`);
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
 * KV cache = 2 (K+V) * n_layers * n_kv_heads * head_dim * 2 bytes (f16)
 */
export function kvCacheBytesPerToken(info: GGUFModelInfo): number {
  const headDim = info.embeddingLength / info.headCount;
  return 2 * info.blockCount * info.headCountKv * headDim * 2;
}

/**
 * Calculates optimal context size based on available system RAM.
 * Accounts for model weights, KV cache, and OS overhead.
 */
/**
 * Returns effective total memory, respecting container cgroup limits.
 * os.totalmem() returns host RAM even inside Docker, so we check cgroup first.
 */
function getEffectiveMemory(): number {
  const hostRam = os.totalmem();
  if (process.platform !== 'linux') return hostRam;
  try {
    // cgroup v2
    const raw = readFileSync('/sys/fs/cgroup/memory.max', 'utf-8').trim();
    if (raw !== 'max') return Math.min(Number(raw), hostRam);
  } catch { /* not cgroup v2 */ }
  try {
    // cgroup v1
    const raw = readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf-8').trim();
    const limit = Number(raw);
    if (limit > 0 && limit < hostRam) return limit;
  } catch { /* not cgroup v1 */ }
  return hostRam;
}

export function calculateOptimalContextSize(info: GGUFModelInfo): number {
  const totalRam = getEffectiveMemory();
  const availableForModel = totalRam - OS_RESERVED_BYTES;
  const memAfterWeights = availableForModel - info.fileSizeBytes;

  if (memAfterWeights <= 0) {
    logger.warn(`[GGUFReader] Model file (${(info.fileSizeBytes / 1024 / 1024 / 1024).toFixed(1)}GB) exceeds available memory, using minimum context`);
    return 2048;
  }

  const bytesPerToken = kvCacheBytesPerToken(info);
  // Use at most 50% of available-after-weights for KV cache — leave headroom for runtime allocations
  const maxCtxByRam = Math.floor((memAfterWeights * 0.5) / bytesPerToken);
  // Hard cap: 32K tokens is practical for local models, avoids memory pressure on small machines
  const MAX_CONTEXT_CAP = 32768;
  const nativeCtx = info.contextLength;

  const optimal = Math.min(maxCtxByRam, nativeCtx, MAX_CONTEXT_CAP);
  // Floor to nearest 1024 for cleanliness, minimum 2048
  const result = Math.max(2048, Math.floor(optimal / 1024) * 1024);

  logger.info(`[GGUFReader] RAM: ${(totalRam / 1024 / 1024 / 1024).toFixed(0)}GB total, ${(memAfterWeights / 1024 / 1024 / 1024).toFixed(1)}GB available for KV | KV/token: ${bytesPerToken} bytes | max by RAM: ${maxCtxByRam} | native: ${nativeCtx} | cap: ${MAX_CONTEXT_CAP} | optimal: ${result}`);
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
