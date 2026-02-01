import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../logger.js';

const logger = createLogger('KnowledgeMetadata');

const METADATA_FILE = 'metadata.json';

export type KnowledgeStoreStatus = 'not_indexed' | 'indexing' | 'indexed' | 'error';

export interface KnowledgeStoreMetadata {
  name: string;
  kind: 'vector' | 'graph-rag';
  status: KnowledgeStoreStatus;
  lastIndexedAt: string | null;
  lastIndexDurationMs: number | null;
  documentCount: number;
  chunkCount: number;
  entityCount: number;
  edgeCount: number;
  communityCount: number;
  errorMessage: string | null;
  sourceHashes: Record<string, string>;
  embeddingModel: string;
  cacheVersion: string;
}

export type IndexingPhase = 'loading' | 'splitting' | 'embedding' | 'extracting' | 'building' | 'caching' | 'done' | 'error';

export interface IndexingProgressEvent {
  name: string;
  phase: IndexingPhase;
  progress: number;
  message: string;
}

export type IndexingProgressCallback = (event: IndexingProgressEvent) => void;

export function createDefaultMetadata(name: string, kind: 'vector' | 'graph-rag'): KnowledgeStoreMetadata {
  return {
    name,
    kind,
    status: 'not_indexed',
    lastIndexedAt: null,
    lastIndexDurationMs: null,
    documentCount: 0,
    chunkCount: 0,
    entityCount: 0,
    edgeCount: 0,
    communityCount: 0,
    errorMessage: null,
    sourceHashes: {},
    embeddingModel: '',
    cacheVersion: '1.0',
  };
}

export class KnowledgeMetadataManager {
  private cacheBaseDir: string;

  constructor(cacheBaseDir: string) {
    this.cacheBaseDir = cacheBaseDir;
  }

  private metadataPath(name: string): string {
    return path.join(this.cacheBaseDir, name, METADATA_FILE);
  }

  async load(name: string): Promise<KnowledgeStoreMetadata | null> {
    try {
      const content = await fs.readFile(this.metadataPath(name), 'utf-8');
      return JSON.parse(content) as KnowledgeStoreMetadata;
    } catch {
      return null;
    }
  }

  async save(name: string, metadata: KnowledgeStoreMetadata): Promise<void> {
    const dir = path.join(this.cacheBaseDir, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.metadataPath(name), JSON.stringify(metadata, null, 2));
  }

  async getAll(knownNames: string[]): Promise<Map<string, KnowledgeStoreMetadata>> {
    const result = new Map<string, KnowledgeStoreMetadata>();
    for (const name of knownNames) {
      const metadata = await this.load(name);
      if (metadata) {
        result.set(name, metadata);
      }
    }
    return result;
  }

  async setStatus(
    name: string,
    status: KnowledgeStoreStatus,
    errorMessage?: string
  ): Promise<void> {
    let metadata = await this.load(name);
    if (!metadata) {
      logger.warn(`No metadata found for "${name}" when setting status to "${status}", skipping`);
      return;
    }
    metadata.status = status;
    metadata.errorMessage = errorMessage ?? null;
    await this.save(name, metadata);
  }

  async delete(name: string): Promise<void> {
    try {
      const dir = path.join(this.cacheBaseDir, name);
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      // Directory may not exist
    }
  }

  getCacheDir(name: string): string {
    return path.join(this.cacheBaseDir, name);
  }

  async resetStaleIndexing(knownNames: string[]): Promise<void> {
    for (const name of knownNames) {
      const metadata = await this.load(name);
      if (metadata && metadata.status === 'indexing') {
        logger.warn(`"${name}" has stale 'indexing' status from a previous run, resetting to 'error'`);
        metadata.status = 'error';
        metadata.errorMessage = 'Process was interrupted during indexing';
        await this.save(name, metadata);
      }
    }
  }

  get baseDir(): string {
    return this.cacheBaseDir;
  }
}
