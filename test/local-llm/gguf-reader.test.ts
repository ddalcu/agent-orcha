import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Mock the logger before importing
mock.module('../../lib/logger.ts', {
  namedExports: {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  },
});

const { readGGUFModelInfo, kvCacheBytesPerToken, calculateOptimalContextSize } = await import(
  '../../lib/local-llm/gguf-reader.ts'
);

const TMP_DIR = path.join(import.meta.dirname, '..', '..', 'tmp', 'test-gguf');

async function ensureTmpDir() {
  await fs.mkdir(TMP_DIR, { recursive: true });
}

const GGUF_MAGIC = 0x46554747;

/**
 * Build a minimal GGUF v3 file buffer with the given KV pairs.
 * Each key-value is { key: string, vtype: number, value: Buffer }
 */
function buildGGUFBuffer(
  kvPairs: { key: string; vtype: number; value: Buffer }[],
  options?: { magic?: number; version?: number; tensorCount?: bigint }
): Buffer {
  const magic = options?.magic ?? GGUF_MAGIC;
  const version = options?.version ?? 3;
  const tensorCount = options?.tensorCount ?? 0n;

  // Header: magic(4) + version(4) + tensorCount(8) + kvCount(8) = 24 bytes
  const headerSize = 24;
  let kvDataSize = 0;
  for (const kv of kvPairs) {
    // keyLen(8) + key(N) + vtype(4) + value(M)
    kvDataSize += 8 + kv.key.length + 4 + kv.value.length;
  }

  const buf = Buffer.alloc(headerSize + kvDataSize);
  buf.writeUInt32LE(magic, 0);
  buf.writeUInt32LE(version, 4);
  buf.writeBigUInt64LE(BigInt(tensorCount), 8);
  buf.writeBigUInt64LE(BigInt(kvPairs.length), 16);

  let pos = 24;
  for (const kv of kvPairs) {
    buf.writeBigUInt64LE(BigInt(kv.key.length), pos);
    pos += 8;
    buf.write(kv.key, pos, 'utf-8');
    pos += kv.key.length;
    buf.writeUInt32LE(kv.vtype, pos);
    pos += 4;
    kv.value.copy(buf, pos);
    pos += kv.value.length;
  }

  return buf;
}

function uint32Value(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}

function uint16Value(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}

function uint8Value(n: number): Buffer {
  const b = Buffer.alloc(1);
  b.writeUInt8(n, 0);
  return b;
}

function int32Value(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32LE(n, 0);
  return b;
}

function float32Value(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeFloatLE(n, 0);
  return b;
}

function uint64Value(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n, 0);
  return b;
}

function int64Value(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(n, 0);
  return b;
}

function float64Value(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(n, 0);
  return b;
}

function int8Value(n: number): Buffer {
  const b = Buffer.alloc(1);
  b.writeInt8(n, 0);
  return b;
}

function int16Value(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeInt16LE(n, 0);
  return b;
}

// String value: 8 bytes length + string bytes
function stringValue(s: string): Buffer {
  const b = Buffer.alloc(8 + s.length);
  b.writeBigUInt64LE(BigInt(s.length), 0);
  Buffer.from(s, 'utf-8').copy(b, 8);
  return b;
}

// Array value: elemType(4) + count(8) + elements
function arrayValue(elemType: number, elements: Buffer[]): Buffer {
  let totalElemSize = 0;
  for (const e of elements) totalElemSize += e.length;
  const b = Buffer.alloc(12 + totalElemSize);
  b.writeUInt32LE(elemType, 0);
  b.writeBigUInt64LE(BigInt(elements.length), 4);
  let pos = 12;
  for (const e of elements) {
    e.copy(b, pos);
    pos += e.length;
  }
  return b;
}

describe('readGGUFModelInfo', () => {
  beforeEach(async () => {
    await ensureTmpDir();
  });

  it('should read a valid GGUF file with all architecture metadata', async () => {
    const kvPairs = [
      { key: 'llama.context_length', vtype: 4, value: uint32Value(4096) },
      { key: 'llama.block_count', vtype: 4, value: uint32Value(32) },
      { key: 'llama.embedding_length', vtype: 4, value: uint32Value(4096) },
      { key: 'llama.attention.head_count', vtype: 4, value: uint32Value(32) },
      { key: 'llama.attention.head_count_kv', vtype: 4, value: uint32Value(8) },
    ];

    const buf = buildGGUFBuffer(kvPairs);
    const filePath = path.join(TMP_DIR, 'valid-model.gguf');
    await fs.writeFile(filePath, buf);

    const info = await readGGUFModelInfo(filePath);

    assert.ok(info);
    assert.strictEqual(info.contextLength, 4096);
    assert.strictEqual(info.blockCount, 32);
    assert.strictEqual(info.embeddingLength, 4096);
    assert.strictEqual(info.headCount, 32);
    assert.strictEqual(info.headCountKv, 8);
    assert.ok(info.fileSizeBytes > 0);

    await fs.unlink(filePath);
  });

  it('should return null for non-GGUF file (bad magic)', async () => {
    const buf = buildGGUFBuffer([], { magic: 0x12345678 });
    const filePath = path.join(TMP_DIR, 'bad-magic.gguf');
    await fs.writeFile(filePath, buf);

    const info = await readGGUFModelInfo(filePath);
    assert.strictEqual(info, null);

    await fs.unlink(filePath);
  });

  it('should return null for unsupported GGUF version (v1)', async () => {
    const buf = buildGGUFBuffer([], { version: 1 });
    const filePath = path.join(TMP_DIR, 'old-version.gguf');
    await fs.writeFile(filePath, buf);

    const info = await readGGUFModelInfo(filePath);
    assert.strictEqual(info, null);

    await fs.unlink(filePath);
  });

  it('should return null for unsupported GGUF version (v4)', async () => {
    const buf = buildGGUFBuffer([], { version: 4 });
    const filePath = path.join(TMP_DIR, 'v4.gguf');
    await fs.writeFile(filePath, buf);

    const info = await readGGUFModelInfo(filePath);
    assert.strictEqual(info, null);

    await fs.unlink(filePath);
  });

  it('should accept GGUF version 2', async () => {
    const kvPairs = [
      { key: 'llama.context_length', vtype: 4, value: uint32Value(2048) },
      { key: 'llama.block_count', vtype: 4, value: uint32Value(16) },
      { key: 'llama.embedding_length', vtype: 4, value: uint32Value(2048) },
      { key: 'llama.attention.head_count', vtype: 4, value: uint32Value(16) },
      { key: 'llama.attention.head_count_kv', vtype: 4, value: uint32Value(4) },
    ];

    const buf = buildGGUFBuffer(kvPairs, { version: 2 });
    const filePath = path.join(TMP_DIR, 'v2-model.gguf');
    await fs.writeFile(filePath, buf);

    const info = await readGGUFModelInfo(filePath);
    assert.ok(info);
    assert.strictEqual(info.contextLength, 2048);

    await fs.unlink(filePath);
  });

  it('should return null if file is too small (< 24 bytes)', async () => {
    const filePath = path.join(TMP_DIR, 'tiny.gguf');
    await fs.writeFile(filePath, Buffer.alloc(10));

    const info = await readGGUFModelInfo(filePath);
    assert.strictEqual(info, null);

    await fs.unlink(filePath);
  });

  it('should return null if context_length is not found', async () => {
    const kvPairs = [
      { key: 'llama.block_count', vtype: 4, value: uint32Value(32) },
      { key: 'llama.embedding_length', vtype: 4, value: uint32Value(4096) },
    ];

    const buf = buildGGUFBuffer(kvPairs);
    const filePath = path.join(TMP_DIR, 'no-ctx.gguf');
    await fs.writeFile(filePath, buf);

    const info = await readGGUFModelInfo(filePath);
    assert.strictEqual(info, null);

    await fs.unlink(filePath);
  });

  it('should return null for non-existent file', async () => {
    const info = await readGGUFModelInfo('/nonexistent/path/model.gguf');
    assert.strictEqual(info, null);
  });

  it('should handle different scalar types for metadata values', async () => {
    // Test with uint8 (vtype 0) for context_length
    const kvPairs = [
      { key: 'llama.context_length', vtype: 0, value: uint8Value(128) },
      { key: 'llama.block_count', vtype: 1, value: int8Value(24) },
      { key: 'llama.embedding_length', vtype: 2, value: uint16Value(512) },
      { key: 'llama.attention.head_count', vtype: 3, value: int16Value(8) },
      { key: 'llama.attention.head_count_kv', vtype: 5, value: int32Value(4) },
    ];

    const buf = buildGGUFBuffer(kvPairs);
    const filePath = path.join(TMP_DIR, 'mixed-types.gguf');
    await fs.writeFile(filePath, buf);

    const info = await readGGUFModelInfo(filePath);
    assert.ok(info);
    assert.strictEqual(info.contextLength, 128);
    assert.strictEqual(info.blockCount, 24);
    assert.strictEqual(info.embeddingLength, 512);
    assert.strictEqual(info.headCount, 8);
    assert.strictEqual(info.headCountKv, 4);

    await fs.unlink(filePath);
  });

  it('should handle float32 value type', async () => {
    const kvPairs = [
      { key: 'llama.context_length', vtype: 6, value: float32Value(4096.0) },
      { key: 'llama.block_count', vtype: 4, value: uint32Value(32) },
      { key: 'llama.embedding_length', vtype: 4, value: uint32Value(4096) },
      { key: 'llama.attention.head_count', vtype: 4, value: uint32Value(32) },
      { key: 'llama.attention.head_count_kv', vtype: 4, value: uint32Value(8) },
    ];

    const buf = buildGGUFBuffer(kvPairs);
    const filePath = path.join(TMP_DIR, 'float-ctx.gguf');
    await fs.writeFile(filePath, buf);

    const info = await readGGUFModelInfo(filePath);
    assert.ok(info);
    assert.strictEqual(info.contextLength, 4096);

    await fs.unlink(filePath);
  });

  it('should handle bool value type (vtype 7)', async () => {
    const kvPairs = [
      { key: 'llama.context_length', vtype: 7, value: uint8Value(1) },
      { key: 'llama.block_count', vtype: 4, value: uint32Value(32) },
      { key: 'llama.embedding_length', vtype: 4, value: uint32Value(4096) },
      { key: 'llama.attention.head_count', vtype: 4, value: uint32Value(32) },
      { key: 'llama.attention.head_count_kv', vtype: 4, value: uint32Value(8) },
    ];

    const buf = buildGGUFBuffer(kvPairs);
    const filePath = path.join(TMP_DIR, 'bool-ctx.gguf');
    await fs.writeFile(filePath, buf);

    const info = await readGGUFModelInfo(filePath);
    assert.ok(info);
    assert.strictEqual(info.contextLength, 1);

    await fs.unlink(filePath);
  });

  it('should handle uint64 value type (vtype 10)', async () => {
    const kvPairs = [
      { key: 'llama.context_length', vtype: 10, value: uint64Value(8192n) },
      { key: 'llama.block_count', vtype: 4, value: uint32Value(32) },
      { key: 'llama.embedding_length', vtype: 4, value: uint32Value(4096) },
      { key: 'llama.attention.head_count', vtype: 4, value: uint32Value(32) },
      { key: 'llama.attention.head_count_kv', vtype: 4, value: uint32Value(8) },
    ];

    const buf = buildGGUFBuffer(kvPairs);
    const filePath = path.join(TMP_DIR, 'u64-ctx.gguf');
    await fs.writeFile(filePath, buf);

    const info = await readGGUFModelInfo(filePath);
    assert.ok(info);
    assert.strictEqual(info.contextLength, 8192);

    await fs.unlink(filePath);
  });

  it('should handle int64 value type (vtype 11)', async () => {
    const kvPairs = [
      { key: 'llama.context_length', vtype: 11, value: int64Value(16384n) },
      { key: 'llama.block_count', vtype: 4, value: uint32Value(32) },
      { key: 'llama.embedding_length', vtype: 4, value: uint32Value(4096) },
      { key: 'llama.attention.head_count', vtype: 4, value: uint32Value(32) },
      { key: 'llama.attention.head_count_kv', vtype: 4, value: uint32Value(8) },
    ];

    const buf = buildGGUFBuffer(kvPairs);
    const filePath = path.join(TMP_DIR, 'i64-ctx.gguf');
    await fs.writeFile(filePath, buf);

    const info = await readGGUFModelInfo(filePath);
    assert.ok(info);
    assert.strictEqual(info.contextLength, 16384);

    await fs.unlink(filePath);
  });

  it('should handle double value type (vtype 12)', async () => {
    const kvPairs = [
      { key: 'llama.context_length', vtype: 12, value: float64Value(32768.0) },
      { key: 'llama.block_count', vtype: 4, value: uint32Value(32) },
      { key: 'llama.embedding_length', vtype: 4, value: uint32Value(4096) },
      { key: 'llama.attention.head_count', vtype: 4, value: uint32Value(32) },
      { key: 'llama.attention.head_count_kv', vtype: 4, value: uint32Value(8) },
    ];

    const buf = buildGGUFBuffer(kvPairs);
    const filePath = path.join(TMP_DIR, 'double-ctx.gguf');
    await fs.writeFile(filePath, buf);

    const info = await readGGUFModelInfo(filePath);
    assert.ok(info);
    assert.strictEqual(info.contextLength, 32768);

    await fs.unlink(filePath);
  });

  it('should skip string KV values (vtype 8) and continue parsing', async () => {
    const kvPairs = [
      { key: 'general.architecture', vtype: 8, value: stringValue('llama') },
      { key: 'llama.context_length', vtype: 4, value: uint32Value(4096) },
      { key: 'llama.block_count', vtype: 4, value: uint32Value(32) },
      { key: 'llama.embedding_length', vtype: 4, value: uint32Value(4096) },
      { key: 'llama.attention.head_count', vtype: 4, value: uint32Value(32) },
      { key: 'llama.attention.head_count_kv', vtype: 4, value: uint32Value(8) },
    ];

    const buf = buildGGUFBuffer(kvPairs);
    const filePath = path.join(TMP_DIR, 'with-string.gguf');
    await fs.writeFile(filePath, buf);

    const info = await readGGUFModelInfo(filePath);
    assert.ok(info);
    assert.strictEqual(info.contextLength, 4096);
    assert.strictEqual(info.blockCount, 32);

    await fs.unlink(filePath);
  });

  it('should skip array KV values (vtype 9) and continue parsing', async () => {
    const kvPairs = [
      { key: 'tokenizer.list', vtype: 9, value: arrayValue(4, [uint32Value(1), uint32Value(2)]) },
      { key: 'llama.context_length', vtype: 4, value: uint32Value(4096) },
      { key: 'llama.block_count', vtype: 4, value: uint32Value(32) },
      { key: 'llama.embedding_length', vtype: 4, value: uint32Value(4096) },
      { key: 'llama.attention.head_count', vtype: 4, value: uint32Value(32) },
      { key: 'llama.attention.head_count_kv', vtype: 4, value: uint32Value(8) },
    ];

    const buf = buildGGUFBuffer(kvPairs);
    const filePath = path.join(TMP_DIR, 'with-array.gguf');
    await fs.writeFile(filePath, buf);

    const info = await readGGUFModelInfo(filePath);
    assert.ok(info);
    assert.strictEqual(info.contextLength, 4096);

    await fs.unlink(filePath);
  });

  it('should stop early when all needed keys are found', async () => {
    // Include architecture keys first, then extra keys that should be skipped
    const kvPairs = [
      { key: 'llama.context_length', vtype: 4, value: uint32Value(4096) },
      { key: 'llama.block_count', vtype: 4, value: uint32Value(32) },
      { key: 'llama.embedding_length', vtype: 4, value: uint32Value(4096) },
      { key: 'llama.attention.head_count', vtype: 4, value: uint32Value(32) },
      { key: 'llama.attention.head_count_kv', vtype: 4, value: uint32Value(8) },
      { key: 'extra.unused_key', vtype: 4, value: uint32Value(999) },
    ];

    const buf = buildGGUFBuffer(kvPairs);
    const filePath = path.join(TMP_DIR, 'early-stop.gguf');
    await fs.writeFile(filePath, buf);

    const info = await readGGUFModelInfo(filePath);
    assert.ok(info);
    assert.strictEqual(info.contextLength, 4096);

    await fs.unlink(filePath);
  });

  it('should handle unknown vtype by returning -1 from skipValue', async () => {
    // Put an unknown vtype (255) in a KV entry before the architecture keys
    const kvPairs = [
      { key: 'unknown.field', vtype: 255, value: Buffer.alloc(0) },
      { key: 'llama.context_length', vtype: 4, value: uint32Value(4096) },
    ];

    const buf = buildGGUFBuffer(kvPairs);
    const filePath = path.join(TMP_DIR, 'unknown-vtype.gguf');
    await fs.writeFile(filePath, buf);

    // Should break out of loop due to skipValue returning -1, then context_length not found
    const info = await readGGUFModelInfo(filePath);
    assert.strictEqual(info, null);

    await fs.unlink(filePath);
  });
});

describe('kvCacheBytesPerToken', () => {
  it('should calculate KV cache bytes per token correctly', () => {
    const info = {
      contextLength: 4096,
      blockCount: 32,
      embeddingLength: 4096,
      headCount: 32,
      headCountKv: 8,
      fileSizeBytes: 1_000_000_000,
    };

    // headDim = 4096/32 = 128
    // bytes = 2 * 32 * 8 * 128 * 2 = 131072
    const bytes = kvCacheBytesPerToken(info);
    assert.strictEqual(bytes, 131072);
  });

  it('should handle different head dimensions', () => {
    const info = {
      contextLength: 2048,
      blockCount: 24,
      embeddingLength: 2048,
      headCount: 16,
      headCountKv: 4,
      fileSizeBytes: 500_000_000,
    };

    // headDim = 2048/16 = 128
    // bytes = 2 * 24 * 4 * 128 * 2 = 49152
    const bytes = kvCacheBytesPerToken(info);
    assert.strictEqual(bytes, 49152);
  });
});

describe('calculateOptimalContextSize', () => {
  it('should return minimum 2048 when model size exceeds available RAM', () => {
    const info = {
      contextLength: 32768,
      blockCount: 80,
      embeddingLength: 8192,
      headCount: 64,
      headCountKv: 8,
      fileSizeBytes: os.totalmem(), // Model larger than available RAM
    };

    const result = calculateOptimalContextSize(info);
    assert.strictEqual(result, 2048);
  });

  it('should not exceed the native context length', () => {
    const info = {
      contextLength: 2048, // small native context
      blockCount: 1,
      embeddingLength: 64,
      headCount: 1,
      headCountKv: 1,
      fileSizeBytes: 1024, // tiny model
    };

    const result = calculateOptimalContextSize(info);
    assert.ok(result <= 2048);
    assert.ok(result >= 2048); // Minimum is 2048 anyway
  });

  it('should not exceed 32768 cap', () => {
    const info = {
      contextLength: 131072, // Very large native context
      blockCount: 1,
      embeddingLength: 64,
      headCount: 1,
      headCountKv: 1,
      fileSizeBytes: 1024,
    };

    const result = calculateOptimalContextSize(info);
    assert.ok(result <= 32768);
  });

  it('should floor to nearest 1024', () => {
    const result = calculateOptimalContextSize({
      contextLength: 100000,
      blockCount: 32,
      embeddingLength: 4096,
      headCount: 32,
      headCountKv: 8,
      fileSizeBytes: 1024,
    });

    assert.strictEqual(result % 1024, 0);
  });

  it('should return a result >= 2048', () => {
    const info = {
      contextLength: 4096,
      blockCount: 32,
      embeddingLength: 4096,
      headCount: 32,
      headCountKv: 8,
      fileSizeBytes: 4_000_000_000,
    };

    const result = calculateOptimalContextSize(info);
    assert.ok(result >= 2048);
  });
});
