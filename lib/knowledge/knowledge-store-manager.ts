import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';
import { parse as parseYaml } from 'yaml';
import { KnowledgeConfigSchema, type KnowledgeConfig, type VectorKnowledgeConfig, type GraphRagKnowledgeConfig, type KnowledgeStoreInstance } from './types.js';
import { KnowledgeStoreFactory } from './knowledge-store-factory.js';
import { GraphRagFactory } from './graph-rag/graph-rag-factory.js';
import { KnowledgeMetadataManager, createDefaultMetadata, type KnowledgeStoreMetadata, type IndexingProgressCallback } from './knowledge-store-metadata.js';
import { createLogger } from '../logger.js';

const logger = createLogger('KnowledgeStore');

export class KnowledgeStoreManager {
  private knowledgeDir: string;
  private projectRoot: string;
  private stores: Map<string, KnowledgeStoreInstance> = new Map();
  private configs: Map<string, KnowledgeConfig> = new Map();
  private metadataManager: KnowledgeMetadataManager;
  private activeIndexing: Map<string, Promise<KnowledgeStoreInstance>> = new Map();

  constructor(knowledgeDir: string, projectRoot: string) {
    this.knowledgeDir = knowledgeDir;
    this.projectRoot = projectRoot;
    this.metadataManager = new KnowledgeMetadataManager(
      path.join(projectRoot, '.knowledge-cache')
    );
  }

  async loadAll(): Promise<void> {
    const files = await glob('**/*.knowledge.yaml', { cwd: this.knowledgeDir });

    for (const file of files) {
      const filePath = path.join(this.knowledgeDir, file);
      try {
        await this.loadOne(filePath);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`Skipping invalid knowledge file "${file}": ${message}`);
      }
    }

    // Reset any metadata stuck in 'indexing' from a previous interrupted run
    const names = Array.from(this.configs.keys());
    await this.metadataManager.resetStaleIndexing(names);

    // Auto-restore previously indexed stores from cache
    await this.restoreIndexedStores();
  }

  /**
   * Restore stores that were previously indexed (status='indexed' in metadata).
   * They will load from disk cache without re-extracting, which is fast.
   */
  private async restoreIndexedStores(): Promise<void> {
    const statuses = await this.getAllStatuses();

    for (const [name, metadata] of statuses) {
      if (metadata.status !== 'indexed') continue;
      if (this.stores.has(name)) continue;

      try {
        logger.info(`Restoring "${name}" from cache...`);
        await this.initialize(name);
      } catch (error) {
        logger.warn(`Failed to restore "${name}": ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async loadOne(filePath: string): Promise<KnowledgeConfig> {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = parseYaml(content);
    const config = KnowledgeConfigSchema.parse(parsed);
    this.configs.set(config.name, config);
    return config;
  }

  async initialize(
    name: string,
    onProgress?: IndexingProgressCallback
  ): Promise<KnowledgeStoreInstance> {
    const existing = this.stores.get(name);
    if (existing) {
      logger.info(`"${name}" already initialized`);
      return existing;
    }

    // Prevent concurrent indexing of the same store
    const activePromise = this.activeIndexing.get(name);
    if (activePromise) {
      logger.info(`"${name}" is already being indexed, waiting...`);
      return activePromise;
    }

    const config = this.configs.get(name);
    if (!config) {
      throw new Error(`Knowledge config not found: ${name}`);
    }

    const promise = this.doInitialize(name, config, onProgress);
    this.activeIndexing.set(name, promise);

    try {
      const store = await promise;
      return store;
    } finally {
      this.activeIndexing.delete(name);
    }
  }

  private async doInitialize(
    name: string,
    config: KnowledgeConfig,
    onProgress?: IndexingProgressCallback
  ): Promise<KnowledgeStoreInstance> {
    logger.info(`Initializing "${name}" (kind: ${config.kind})...`);

    // Log source-specific info
    if (config.source.type === 'directory' || config.source.type === 'file') {
      logger.info(`Source: ${config.source.path}, Pattern: ${'pattern' in config.source ? config.source.pattern || '*' : 'N/A'}`);
    } else if (config.source.type === 'database') {
      logger.info(`Source: database (${config.source.connectionString.split('@')[1] || 'unknown'})`);
    } else if (config.source.type === 'web') {
      logger.info(`Source: web (${config.source.url})`);
    }

    // Set status to indexing
    const metadata = createDefaultMetadata(name, config.kind);
    metadata.status = 'indexing';
    metadata.embeddingModel = config.embedding;
    await this.metadataManager.save(name, metadata);

    onProgress?.({ name, phase: 'loading', progress: 0, message: 'Starting initialization...' });

    const startTime = Date.now();

    try {
      let store: KnowledgeStoreInstance;
      const cacheDir = this.metadataManager.getCacheDir(name);

      if (config.kind === 'graph-rag') {
        store = await GraphRagFactory.create(
          config as GraphRagKnowledgeConfig,
          this.projectRoot,
          cacheDir,
          onProgress
        );
      } else {
        store = await KnowledgeStoreFactory.create(
          config as VectorKnowledgeConfig,
          this.projectRoot,
          cacheDir,
          onProgress
        );
      }

      this.stores.set(name, store);

      // Update metadata on success
      const storeMetadata = store.getMetadata();
      storeMetadata.status = 'indexed';
      storeMetadata.lastIndexedAt = new Date().toISOString();
      storeMetadata.lastIndexDurationMs = Date.now() - startTime;
      storeMetadata.errorMessage = null;
      await this.metadataManager.save(name, storeMetadata);

      onProgress?.({ name, phase: 'done', progress: 100, message: 'Initialization complete' });

      logger.info(`"${name}" initialized successfully (${storeMetadata.lastIndexDurationMs}ms)`);
      return store;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Update metadata on failure
      metadata.status = 'error';
      metadata.errorMessage = errorMessage;
      metadata.lastIndexDurationMs = Date.now() - startTime;
      await this.metadataManager.save(name, metadata);

      onProgress?.({ name, phase: 'error', progress: 0, message: errorMessage });

      logger.error(`Failed to initialize "${name}":`, error);
      throw error;
    }
  }

  get(name: string): KnowledgeStoreInstance | undefined {
    return this.stores.get(name);
  }

  getConfig(name: string): KnowledgeConfig | undefined {
    return this.configs.get(name);
  }

  list(): KnowledgeStoreInstance[] {
    return Array.from(this.stores.values());
  }

  listConfigs(): KnowledgeConfig[] {
    return Array.from(this.configs.values());
  }

  async getStatus(name: string): Promise<KnowledgeStoreMetadata | null> {
    return this.metadataManager.load(name);
  }

  async getAllStatuses(): Promise<Map<string, KnowledgeStoreMetadata>> {
    const names = Array.from(this.configs.keys());
    return this.metadataManager.getAll(names);
  }

  getMetadataManager(): KnowledgeMetadataManager {
    return this.metadataManager;
  }

  isIndexing(name: string): boolean {
    return this.activeIndexing.has(name);
  }

  async refresh(name: string, onProgress?: IndexingProgressCallback): Promise<void> {
    const store = this.stores.get(name);
    if (!store) return;

    const config = this.configs.get(name);
    if (config) {
      const metadata = await this.metadataManager.load(name);
      if (metadata) {
        metadata.status = 'indexing';
        await this.metadataManager.save(name, metadata);
      }
    }

    // Track refresh in activeIndexing so isIndexing() returns true
    const refreshPromise = this.doRefresh(name, store, onProgress);
    this.activeIndexing.set(name, refreshPromise as Promise<KnowledgeStoreInstance>);

    try {
      await refreshPromise;
    } finally {
      this.activeIndexing.delete(name);
    }
  }

  private async doRefresh(
    name: string,
    store: KnowledgeStoreInstance,
    onProgress?: IndexingProgressCallback
  ): Promise<KnowledgeStoreInstance> {
    onProgress?.({ name, phase: 'loading', progress: 0, message: 'Starting refresh...' });
    const startTime = Date.now();

    try {
      await store.refresh(onProgress);

      const storeMetadata = store.getMetadata();
      storeMetadata.status = 'indexed';
      storeMetadata.lastIndexedAt = new Date().toISOString();
      storeMetadata.lastIndexDurationMs = Date.now() - startTime;
      storeMetadata.errorMessage = null;
      await this.metadataManager.save(name, storeMetadata);

      onProgress?.({ name, phase: 'done', progress: 100, message: 'Refresh complete' });
      return store;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const metadata = await this.metadataManager.load(name);
      if (metadata) {
        metadata.status = 'error';
        metadata.errorMessage = errorMessage;
        await this.metadataManager.save(name, metadata);
      }

      onProgress?.({ name, phase: 'error', progress: 0, message: errorMessage });
      throw error;
    }
  }
}
