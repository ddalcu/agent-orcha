import * as fs from 'fs/promises';
import * as path from 'path';
import { MemoryVectorStore } from './memory-vector-store.ts';
import type { Embeddings } from '../types/llm-types.ts';
import { createLogger } from '../logger.ts';

const logger = createLogger('VectorStoreCache');

const CACHE_VERSION = '1.0';
const VECTORS_FILE = 'vectors.json';

interface CachedVector {
  content: string;
  embedding: number[];
  metadata: Record<string, unknown>;
  id?: string;
}

interface CachedVectorData {
  vectors: CachedVector[];
  embeddingModel: string;
  sourceHashes: Record<string, string>;
  cacheVersion: string;
  createdAt: string;
}

export class VectorStoreCache {
  private cacheDir: string;
  private storeName: string;

  constructor(cacheDir: string, storeName: string) {
    this.cacheDir = cacheDir;
    this.storeName = storeName;
  }

  private get vectorsPath(): string {
    return path.join(this.cacheDir, VECTORS_FILE);
  }

  async isValid(embeddingModel: string, currentSourceHashes: Record<string, string>): Promise<boolean> {
    try {
      const raw = await fs.readFile(this.vectorsPath, 'utf-8');
      const cached: CachedVectorData = JSON.parse(raw);

      if (cached.cacheVersion !== CACHE_VERSION) {
        logger.info(`Cache version mismatch for "${this.storeName}" (${cached.cacheVersion} vs ${CACHE_VERSION})`);
        return false;
      }

      if (cached.embeddingModel !== embeddingModel) {
        logger.info(`Embedding model changed for "${this.storeName}" (${cached.embeddingModel} vs ${embeddingModel})`);
        return false;
      }

      // Compare source hashes
      const cachedKeys = Object.keys(cached.sourceHashes).sort();
      const currentKeys = Object.keys(currentSourceHashes).sort();

      if (cachedKeys.length !== currentKeys.length) {
        logger.info(`Source file count changed for "${this.storeName}" (${cachedKeys.length} vs ${currentKeys.length})`);
        return false;
      }

      for (let i = 0; i < cachedKeys.length; i++) {
        if (cachedKeys[i] !== currentKeys[i] || cached.sourceHashes[cachedKeys[i]!] !== currentSourceHashes[currentKeys[i]!]) {
          logger.info(`Source file hash changed for "${this.storeName}"`);
          return false;
        }
      }

      return true;
    } catch {
      return false;
    }
  }

  async load(
    embeddings: Embeddings,
    embeddingModel: string,
    currentSourceHashes: Record<string, string>
  ): Promise<{ store: MemoryVectorStore; vectorCount: number } | null> {
    const valid = await this.isValid(embeddingModel, currentSourceHashes);
    if (!valid) return null;

    try {
      const raw = await fs.readFile(this.vectorsPath, 'utf-8');
      const cached: CachedVectorData = JSON.parse(raw);

      if (cached.vectors.length === 0) {
        logger.info(`Cache for "${this.storeName}" has no vectors`);
        return null;
      }

      const store = await MemoryVectorStore.fromExistingIndex(embeddings);
      // Directly assign cached vectors to restore without re-embedding
      (store as any).memoryVectors = cached.vectors;

      logger.info(`Restored "${this.storeName}" from cache (${cached.vectors.length} vectors, cached at ${cached.createdAt})`);
      return { store, vectorCount: cached.vectors.length };
    } catch (error) {
      logger.warn(`Failed to load vector cache for "${this.storeName}":`, error);
      return null;
    }
  }

  async save(
    store: MemoryVectorStore,
    embeddingModel: string,
    sourceHashes: Record<string, string>
  ): Promise<void> {
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });

      const vectors: CachedVector[] = (store as any).memoryVectors.map((v: any) => ({
        content: v.content,
        embedding: v.embedding,
        metadata: v.metadata,
        id: v.id,
      }));

      const data: CachedVectorData = {
        vectors,
        embeddingModel,
        sourceHashes,
        cacheVersion: CACHE_VERSION,
        createdAt: new Date().toISOString(),
      };

      await fs.writeFile(this.vectorsPath, JSON.stringify(data));
      logger.info(`Saved vector cache for "${this.storeName}" (${vectors.length} vectors)`);
    } catch (error) {
      logger.warn(`Failed to save vector cache for "${this.storeName}":`, error);
    }
  }

  async clear(): Promise<void> {
    try {
      await fs.rm(this.vectorsPath, { force: true });
      logger.info(`Vector cache cleared for "${this.storeName}"`);
    } catch {
      // File may not exist
    }
  }
}
