import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import * as path from 'path';
import { glob } from 'glob';
import { parse as parseYaml } from 'yaml';
import { SqliteStore } from './sqlite-store.ts';
import { DirectMapper } from './direct-mapper.ts';
import { KnowledgeConfigSchema } from './types.ts';
import { KnowledgeMetadataManager, createDefaultMetadata } from './knowledge-store-metadata.ts';
import { CharacterTextSplitter, RecursiveCharacterTextSplitter } from '../types/text-splitters.ts';
import { OpenAIEmbeddingsProvider } from '../llm/providers/openai-embeddings.ts';
import { GeminiEmbeddingsProvider } from '../llm/providers/gemini-embeddings.ts';
import { getEmbeddingConfig, resolveApiKey } from '../llm/llm-config.ts';
import { detectProvider } from '../llm/provider-detector.ts';
import { DatabaseLoader, WebLoader, TextLoader, JSONLoader, CSVLoader, PDFLoader } from './loaders/index.ts';
import { createLogger } from '../logger.ts';
import type { Document, Embeddings } from '../types/llm-types.ts';
import type {
  KnowledgeConfig,
  KnowledgeStoreInstance,
  SearchResult,
  DocumentInput,
  ExtractedRelationship,
} from './types.ts';
import type { KnowledgeStoreMetadata, IndexingProgressCallback } from './knowledge-store-metadata.ts';

const logger = createLogger('KnowledgeStore');
const searchLogger = createLogger('KnowledgeSearch');

/**
 * Unified knowledge store. Replaces KnowledgeStoreManager + KnowledgeStoreFactory + GraphRagFactory.
 * All stores use SQLite as persistence — no caching layers.
 * If config.graph exists, entity extraction is enabled; otherwise chunks-only.
 */
export class KnowledgeStore {
  private knowledgeDir: string;
  private projectRoot: string;
  private stores: Map<string, KnowledgeStoreInstance> = new Map();
  private configs: Map<string, KnowledgeConfig> = new Map();
  private sqliteStores: Map<string, SqliteStore> = new Map();
  private metadataManager: KnowledgeMetadataManager;
  private activeIndexing: Map<string, Promise<KnowledgeStoreInstance>> = new Map();

  constructor(knowledgeDir: string, projectRoot: string) {
    this.knowledgeDir = knowledgeDir;
    this.projectRoot = projectRoot;
    this.metadataManager = new KnowledgeMetadataManager(
      path.join(projectRoot, '.knowledge-cache')
    );
  }

  // --- Config Loading ---

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

    const names = Array.from(this.configs.keys());
    await this.metadataManager.resetStaleIndexing(names);
    await this.restoreIndexedStores();
  }

  async loadOne(filePath: string): Promise<KnowledgeConfig> {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = parseYaml(content);
    const config = KnowledgeConfigSchema.parse(parsed);

    // Resolve sqlite:// paths relative to projectRoot so they work regardless of cwd
    if (config.source.type === 'database' && config.source.connectionString.startsWith('sqlite://')) {
      const filePart = config.source.connectionString.replace(/^sqlite:\/\//, '');
      if (!path.isAbsolute(filePart)) {
        config.source.connectionString = `sqlite://${path.resolve(this.projectRoot, filePart)}`;
      }
    }

    this.configs.set(config.name, config);
    return config;
  }

  private async restoreIndexedStores(): Promise<void> {
    const statuses = await this.getAllStatuses();

    for (const [name, metadata] of statuses) {
      if (metadata.status !== 'indexed') continue;
      if (this.stores.has(name)) continue;

      try {
        logger.info(`Restoring "${name}" from SQLite...`);
        await this.initialize(name);
      } catch (error) {
        logger.warn(`Failed to restore "${name}": ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  // --- Initialization ---

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
    const hasGraph = !!config.graph;
    logger.info(`Initializing "${name}" (graph: ${hasGraph})...`);

    if (config.source.type === 'directory' || config.source.type === 'file') {
      logger.info(`Source: ${config.source.path}`);
    } else if (config.source.type === 'database') {
      logger.info(`Source: database (${config.source.connectionString.split('@')[1] || 'unknown'})`);
    } else if (config.source.type === 'web') {
      logger.info(`Source: web (${config.source.url})`);
    }

    const metadata = createDefaultMetadata(name, hasGraph ? 'graph-rag' : 'vector');
    metadata.embeddingModel = config.embedding;
    metadata.status = 'indexing';
    await this.metadataManager.save(name, metadata);

    onProgress?.({ name, phase: 'loading', progress: 0, message: 'Starting initialization...' });
    const startTime = Date.now();

    try {
      // 1. Create embeddings and test to get dimensions
      const embeddings = KnowledgeStore.createEmbeddings(config.embedding);
      const testEmbedding = await embeddings.embedQuery('dimension test');
      const dimensions = testEmbedding.length;
      logger.info(`Embedding dimensions: ${dimensions}`);

      // 2. Determine DB path and open SqliteStore
      const dbPath = path.join(this.projectRoot, '.knowledge-data', `${name}.db`);

      // Check dimension mismatch
      if (!SqliteStore.validateDimensions(dbPath, dimensions)) {
        logger.warn(`Dimension mismatch for "${name}", will re-index`);
        // Delete old DB
        try { await fs.unlink(dbPath); } catch { /* may not exist */ }
      }

      const sqliteStore = new SqliteStore(dbPath, dimensions);

      // 3. Check if DB already has valid data
      const storedHashes = sqliteStore.getMeta('sourceHashes');
      const currentHashes = await KnowledgeStore.computeFileHashes(config, this.projectRoot);
      const currentHashStr = JSON.stringify(currentHashes);
      const isUpToDate = sqliteStore.hasData() && storedHashes === currentHashStr;

      if (isUpToDate) {
        logger.info(`"${name}" restored from SQLite (${sqliteStore.getChunkCount()} chunks, ${sqliteStore.getEntityCount()} entities)`);
        onProgress?.({ name, phase: 'done', progress: 100, message: 'Restored from SQLite' });

        metadata.documentCount = sqliteStore.getChunkCount();
        metadata.chunkCount = sqliteStore.getChunkCount();
        metadata.entityCount = sqliteStore.getEntityCount();
        metadata.edgeCount = sqliteStore.getRelationshipCount();
        metadata.sourceHashes = currentHashes;
      } else {
        // Full indexing pipeline
        sqliteStore.clear();

        onProgress?.({ name, phase: 'loading', progress: 10, message: 'Loading documents...' });
        const documents = await KnowledgeStore.loadDocuments(config, this.projectRoot);
        logger.info(`Loaded ${documents.length} document(s)`);
        metadata.documentCount = documents.length;

        onProgress?.({ name, phase: 'splitting', progress: 20, message: `Splitting ${documents.length} documents...` });
        const splitDocs = await KnowledgeStore.splitDocuments(config, documents);
        logger.info(`Split into ${splitDocs.length} chunk(s)`);
        metadata.chunkCount = splitDocs.length;

        // Embed and insert chunks
        onProgress?.({ name, phase: 'embedding', progress: 35, message: `Embedding ${splitDocs.length} chunks...` });
        const chunkTexts = splitDocs.map(d => d.pageContent);
        const chunkEmbeddings = await embeddings.embedDocuments(chunkTexts);

        const chunkInserts = splitDocs.map((doc, i) => ({
          content: doc.pageContent,
          metadata: doc.metadata,
          source: (doc.metadata?.source as string) ?? '',
          embedding: chunkEmbeddings[i]!,
        }));

        onProgress?.({ name, phase: 'building', progress: 55, message: 'Inserting chunks...' });
        sqliteStore.insertChunks(chunkInserts);

        // Entity extraction (if graph config present)
        if (config.graph) {
          onProgress?.({ name, phase: 'extracting', progress: 60, message: 'Extracting entities...' });

          if (!config.graph.directMapping) {
            throw new Error(`Graph config for "${name}" requires a directMapping configuration`);
          }

          const { entities, relationships } = DirectMapper.mapQueryResults(documents, config.graph.directMapping);

          logger.info(`Extracted ${entities.length} entities, ${relationships.length} relationships`);

          if (entities.length > 0) {
            // Embed entities
            onProgress?.({ name, phase: 'embedding', progress: 75, message: `Embedding ${entities.length} entities...` });
            const entityDescs = entities.map(e => `${e.name}: ${e.description}`);
            const entityEmbeddings = await embeddings.embedDocuments(entityDescs);

            const entityInserts = entities.map((entity, i) => ({
              id: normalizeId(entity.name, entity.type),
              type: entity.type,
              name: entity.name,
              description: entity.description,
              properties: entity.properties,
              sourceChunkIds: (entity.properties.sourceChunkIds as string[]) ?? [],
              embedding: entityEmbeddings[i]!,
            }));

            onProgress?.({ name, phase: 'building', progress: 85, message: 'Inserting entities and relationships...' });
            sqliteStore.insertEntities(entityInserts);

            // Build and insert relationships
            const relInserts = buildRelationships(relationships, entityInserts.map(e => ({ id: e.id, name: e.name, type: e.type })));
            if (relInserts.length > 0) {
              sqliteStore.insertRelationships(relInserts);
            }
          }

          metadata.entityCount = entities.length;
          metadata.edgeCount = relationships.length;
        }

        // Store source hashes
        sqliteStore.setMeta('sourceHashes', currentHashStr);
        metadata.sourceHashes = currentHashes;

        onProgress?.({ name, phase: 'caching', progress: 95, message: 'Finalizing...' });
      }

      // Register stores
      this.sqliteStores.set(name, sqliteStore);

      // Create the KnowledgeStoreInstance
      const instance = this.createInstance(name, config, sqliteStore, embeddings, metadata);
      this.stores.set(name, instance);

      // Update metadata on success
      const storeMetadata = instance.getMetadata();
      storeMetadata.status = 'indexed';
      storeMetadata.lastIndexedAt = new Date().toISOString();
      storeMetadata.lastIndexDurationMs = Date.now() - startTime;
      storeMetadata.errorMessage = null;
      await this.metadataManager.save(name, storeMetadata);

      onProgress?.({ name, phase: 'done', progress: 100, message: 'Initialization complete' });
      logger.info(`"${name}" initialized successfully (${storeMetadata.lastIndexDurationMs}ms)`);

      return instance;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      metadata.status = 'error';
      metadata.errorMessage = errorMessage;
      metadata.lastIndexDurationMs = Date.now() - startTime;
      await this.metadataManager.save(name, metadata);

      onProgress?.({ name, phase: 'error', progress: 0, message: errorMessage });
      logger.error(`Failed to initialize "${name}":`, error);
      throw error;
    }
  }

  private createInstance(
    name: string,
    config: KnowledgeConfig,
    sqliteStore: SqliteStore,
    embeddings: Embeddings,
    metadata: KnowledgeStoreMetadata
  ): KnowledgeStoreInstance {
    return {
      config,
      search: async (query: string, k?: number): Promise<SearchResult[]> => {
        const numResults = k ?? config.search?.defaultK ?? 4;
        searchLogger.info(`Searching "${name}" for: "${query.substring(0, 50)}..." (k=${numResults})`);

        try {
          const queryEmbedding = await embeddings.embedQuery(query);

          // Chunk similarity search
          const chunkResults = sqliteStore.searchChunks(queryEmbedding, numResults);

          // Entity neighborhood search (if entities exist)
          const entityResults: SearchResult[] = [];
          if (sqliteStore.getEntityCount() > 0) {
            const topEntities = sqliteStore.searchEntities(queryEmbedding, Math.min(numResults, 5));
            for (const entity of topEntities) {
              const { entities, relationships } = sqliteStore.getNeighborhood(entity.id, 2);
              const neighborText = formatNeighborhood(entity, entities, relationships);
              entityResults.push({
                content: neighborText,
                metadata: { type: 'entity_neighborhood', entityId: entity.id, entityName: entity.name },
                score: entity.score,
              });
            }
          }

          // Merge all results by score, return top k
          const allResults: SearchResult[] = [
            ...chunkResults.map(r => ({
              content: r.content,
              metadata: r.metadata,
              score: r.score,
            })),
            ...entityResults,
          ];

          allResults.sort((a, b) => b.score - a.score);

          const threshold = config.search?.scoreThreshold;
          const filtered = threshold !== undefined
            ? allResults.filter(r => r.score >= threshold)
            : allResults;

          const final = filtered.slice(0, numResults);
          searchLogger.info(`Results: ${chunkResults.length} chunks, ${entityResults.length} entities → ${final.length} total`);

          return final;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          searchLogger.error(`Error during search: ${errorMessage}`, error);
          return [];
        }
      },
      addDocuments: async (docs: DocumentInput[]): Promise<void> => {
        const texts = docs.map(d => d.content);
        const vectors = await embeddings.embedDocuments(texts);
        sqliteStore.insertChunks(docs.map((d, i) => ({
          content: d.content,
          metadata: d.metadata ?? {},
          source: '',
          embedding: vectors[i]!,
        })));
        metadata.chunkCount = sqliteStore.getChunkCount();
      },
      refresh: async (refreshOnProgress?: IndexingProgressCallback): Promise<void> => {
        refreshOnProgress?.({ name, phase: 'loading', progress: 10, message: 'Checking for changes...' });

        const newSourceHashes = await KnowledgeStore.computeFileHashes(config, this.projectRoot);
        const currentHashStr = JSON.stringify(newSourceHashes);
        const storedHashes = sqliteStore.getMeta('sourceHashes');

        if (currentHashStr === storedHashes) {
          logger.info(`No changes detected for "${name}", skipping refresh`);
          return;
        }

        logger.info(`Changes detected for "${name}", re-indexing...`);

        // Remove current store references, re-initialize
        this.stores.delete(name);
        this.sqliteStores.delete(name);
        sqliteStore.close();

        // Delete old DB file to force full re-index
        try { await fs.unlink(sqliteStore.getDbPath()); } catch { /* */ }

        await this.doInitialize(name, config, refreshOnProgress);
      },
      getMetadata: () => ({ ...metadata }),
    };
  }

  // --- Public Accessors ---

  get(name: string): KnowledgeStoreInstance | undefined {
    return this.stores.get(name);
  }

  getConfig(name: string): KnowledgeConfig | undefined {
    return this.configs.get(name);
  }

  getSqliteStore(name: string): SqliteStore | undefined {
    return this.sqliteStores.get(name);
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

    const refreshPromise = (async () => {
      const startTime = Date.now();
      onProgress?.({ name, phase: 'loading', progress: 0, message: 'Starting refresh...' });

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
    })();

    this.activeIndexing.set(name, refreshPromise as Promise<KnowledgeStoreInstance>);
    try {
      await refreshPromise;
    } finally {
      this.activeIndexing.delete(name);
    }
  }

  // --- Static Helpers (reused from old KnowledgeStoreFactory) ---

  static createEmbeddings(configName: string): Embeddings {
    const embeddingConfig = getEmbeddingConfig(configName);
    const provider = detectProvider(embeddingConfig);
    const eosToken = embeddingConfig.eosToken;

    logger.info(`Embedding model: ${embeddingConfig.model} (provider: ${provider})${embeddingConfig.baseUrl ? `, URL: ${embeddingConfig.baseUrl}` : ''}`);

    let baseEmbeddings: Embeddings;

    switch (provider) {
      case 'gemini':
        baseEmbeddings = new GeminiEmbeddingsProvider({
          modelName: embeddingConfig.model,
          apiKey: resolveApiKey('gemini', embeddingConfig.apiKey),
        });
        break;
      case 'openai':
      case 'local':
      case 'anthropic':
      default: {
        const apiKey = resolveApiKey(provider, embeddingConfig.apiKey);
        baseEmbeddings = new OpenAIEmbeddingsProvider({
          modelName: embeddingConfig.model,
          apiKey,
          baseURL: embeddingConfig.baseUrl,
          dimensions: embeddingConfig.dimensions,
        });
        break;
      }
    }

    return this.wrapWithValidation(baseEmbeddings, eosToken);
  }

  private static wrapWithValidation(embeddings: Embeddings, eosToken?: string): Embeddings {
    const appendToken = (text: string): string => {
      if (!eosToken || text.endsWith(eosToken)) return text;
      return `${text}${eosToken}`;
    };

    const validateEmbedding = (result: number[], context: string): number[] => {
      if (!Array.isArray(result) || result.length === 0) {
        throw new Error(`${context}: Embedding returned invalid format`);
      }
      if (result.some(v => !isFinite(v))) {
        throw new Error(`${context}: Embedding contains NaN or Infinity values`);
      }
      if (result.every(v => v === 0)) {
        throw new Error(`${context}: Embedding returned a zero vector`);
      }
      return result;
    };

    const originalEmbedQuery = embeddings.embedQuery.bind(embeddings);
    const originalEmbedDocuments = embeddings.embedDocuments.bind(embeddings);

    return {
      embedQuery: async (text: string): Promise<number[]> => {
        try {
          return validateEmbedding(await originalEmbedQuery(appendToken(text)), 'embedQuery');
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          throw new Error(`Embedding query failed: ${msg}`);
        }
      },
      embedDocuments: async (texts: string[]): Promise<number[][]> => {
        try {
          const result = await originalEmbedDocuments(texts.map(appendToken));
          return result.map((emb, i) => validateEmbedding(emb, `embedDocuments[${i}]`));
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          throw new Error(`Embedding documents failed: ${msg}`);
        }
      },
    };
  }

  static async loadDocuments(config: KnowledgeConfig, projectRoot: string): Promise<Document[]> {
    if (config.source.type === 'database') {
      const dbLoader = new DatabaseLoader(config.source);
      return dbLoader.load();
    }

    if (config.source.type === 'web') {
      const webLoader = new WebLoader(config.source);
      return webLoader.load();
    }

    const sourcePath = path.join(projectRoot, config.source.path);

    if (config.source.type === 'directory') {
      const pattern = config.source.pattern ?? '*';
      const files = await glob(pattern, { cwd: sourcePath, absolute: true });
      logger.info(`Found ${files.length} file(s) in ${sourcePath}`);

      const allDocs: Document[] = [];
      for (const file of files) {
        const loader = this.createLoader(config.loader.type, file);
        const docs = await loader.load();
        allDocs.push(...docs);
      }
      return allDocs;
    }

    if (config.source.type === 'file') {
      const loader = this.createLoader(config.loader.type, sourcePath);
      return loader.load();
    }

    throw new Error(`Unknown source type: ${(config.source as any).type}`);
  }

  private static createLoader(type: string, filePath: string) {
    switch (type) {
      case 'pdf': return new PDFLoader(filePath);
      case 'csv': return new CSVLoader(filePath);
      case 'json': return new JSONLoader(filePath);
      case 'text':
      case 'markdown':
      default: return new TextLoader(filePath);
    }
  }

  static async splitDocuments(config: KnowledgeConfig, documents: Document[]): Promise<Document[]> {
    const splitterConfig = {
      chunkSize: config.splitter.chunkSize,
      chunkOverlap: config.splitter.chunkOverlap,
      separator: config.splitter.separator,
    };

    const splitter = config.splitter.type === 'recursive'
      ? new RecursiveCharacterTextSplitter(splitterConfig)
      : new CharacterTextSplitter(splitterConfig);

    return splitter.splitDocuments(documents);
  }

  static async computeFileHashes(
    config: KnowledgeConfig,
    projectRoot: string
  ): Promise<Record<string, string>> {
    const hashes: Record<string, string> = {};

    if (config.source.type === 'directory') {
      const sourcePath = path.join(projectRoot, config.source.path);
      const pattern = config.source.pattern ?? '*';
      const files = await glob(pattern, { cwd: sourcePath, absolute: true });
      for (const file of files) {
        const content = await fs.readFile(file);
        hashes[file] = crypto.createHash('sha256').update(content).digest('hex');
      }
    } else if (config.source.type === 'file') {
      const sourcePath = path.join(projectRoot, config.source.path);
      const content = await fs.readFile(sourcePath);
      hashes[sourcePath] = crypto.createHash('sha256').update(content).digest('hex');
    } else if (config.source.type === 'database') {
      hashes['database:query'] = crypto.createHash('sha256').update(config.source.query).digest('hex');
    } else if (config.source.type === 'web') {
      hashes['web:url'] = crypto.createHash('sha256').update(config.source.url).digest('hex');
    }

    return hashes;
  }
}

// --- Helpers ---

function normalizeId(name: string, type: string): string {
  return `${type}::${name}`
    .toLowerCase()
    .replace(/[^a-z0-9:]+/g, '-')
    .replace(/^-|-$/g, '');
}

function buildRelationships(
  relationships: ExtractedRelationship[],
  entities: Array<{ id: string; name: string; type: string }>
): Array<{ id: string; type: string; sourceId: string; targetId: string; description: string; weight: number; properties: Record<string, unknown> }> {
  const nodeIdMap = new Map<string, string>();
  for (const entity of entities) {
    const key = normalizeId(entity.name, entity.type);
    nodeIdMap.set(key, entity.id);
  }

  const result: Array<{ id: string; type: string; sourceId: string; targetId: string; description: string; weight: number; properties: Record<string, unknown> }> = [];

  for (let i = 0; i < relationships.length; i++) {
    const rel = relationships[i]!;
    const sourceKey = normalizeId(rel.sourceName, rel.sourceType);
    const targetKey = normalizeId(rel.targetName, rel.targetType);
    const sourceId = nodeIdMap.get(sourceKey);
    const targetId = nodeIdMap.get(targetKey);

    if (!sourceId || !targetId) continue;

    result.push({
      id: `edge-${i}-${rel.type}`,
      type: rel.type,
      sourceId,
      targetId,
      description: rel.description,
      weight: rel.weight,
      properties: {},
    });
  }

  return result;
}

function formatNeighborhood(
  entity: { id: string; name: string; type: string; description: string },
  neighbors: Array<{ id: string; type: string; name: string; description: string }>,
  relationships: Array<{ type: string; source_id: string; target_id: string; description: string }>
): string {
  const lines: string[] = [];
  lines.push(`[${entity.type}] ${entity.name}: ${entity.description}`);

  if (relationships.length > 0) {
    lines.push('Relationships:');
    for (const rel of relationships.slice(0, 10)) {
      const other = rel.source_id === entity.id
        ? neighbors.find(n => n.id === rel.target_id)
        : neighbors.find(n => n.id === rel.source_id);
      if (other) {
        lines.push(`  -[${rel.type}]-> [${other.type}] ${other.name}`);
      }
    }
  }

  return lines.join('\n');
}
