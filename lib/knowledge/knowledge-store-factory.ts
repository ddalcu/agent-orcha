import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { MemoryVectorStore } from './memory-vector-store.ts';
import { OpenAIEmbeddingsProvider } from '../llm/providers/openai-embeddings.ts';
import { GeminiEmbeddingsProvider } from '../llm/providers/gemini-embeddings.ts';
import { CharacterTextSplitter, RecursiveCharacterTextSplitter } from '../types/text-splitters.ts';
import { glob } from 'glob';
import * as path from 'path';
import type { Document, Embeddings } from '../types/llm-types.ts';
import type { KnowledgeConfig, VectorKnowledgeConfig, KnowledgeStoreInstance, SearchResult, DocumentInput } from './types.ts';
import { getEmbeddingConfig, resolveApiKey } from '../llm/llm-config.ts';
import { detectProvider } from '../llm/provider-detector.ts';
import { createLogger } from '../logger.ts';
import { DatabaseLoader, WebLoader, TextLoader, JSONLoader, CSVLoader, PDFLoader } from './loaders/index.ts';
import { VectorStoreCache } from './vector-store-cache.ts';
import { createDefaultMetadata, type KnowledgeStoreMetadata, type IndexingProgressCallback } from './knowledge-store-metadata.ts';

const logger = createLogger('KnowledgeFactory');
const searchLogger = createLogger('KnowledgeSearch');

export class KnowledgeStoreFactory {
  static async create(
    config: VectorKnowledgeConfig,
    projectRoot: string,
    cacheDir?: string,
    onProgress?: IndexingProgressCallback
  ): Promise<KnowledgeStoreInstance> {
    const embeddingConfigName = config.embedding;
    const embeddings = this.createEmbeddings(embeddingConfigName);

    let metadata = createDefaultMetadata(config.name, 'vector');
    metadata.embeddingModel = embeddingConfigName;

    // Try loading from cache
    if (cacheDir) {
      const cache = new VectorStoreCache(cacheDir, config.name);
      onProgress?.({ name: config.name, phase: 'loading', progress: 5, message: 'Checking cache...' });

      const sourceHashes = await this.computeFileHashes(config, projectRoot);
      const cached = await cache.load(embeddings, embeddingConfigName, sourceHashes);

      if (cached) {
        logger.info(`"${config.name}" restored from cache (${cached.vectorCount} vectors)`);
        onProgress?.({ name: config.name, phase: 'done', progress: 100, message: 'Restored from cache' });

        metadata.documentCount = cached.vectorCount;
        metadata.chunkCount = cached.vectorCount;
        metadata.sourceHashes = sourceHashes;

        return this.wrapAsInstance(config, cached.store, embeddings, metadata, projectRoot, cacheDir);
      }
    }

    onProgress?.({ name: config.name, phase: 'loading', progress: 10, message: 'Loading documents...' });
    logger.info(`Loading documents for "${config.name}"...`);
    const documents = await this.loadDocuments(config, projectRoot);
    logger.info(`Loaded ${documents.length} document(s)`);
    metadata.documentCount = documents.length;

    onProgress?.({ name: config.name, phase: 'splitting', progress: 30, message: `Splitting ${documents.length} documents...` });
    const splitDocs = await this.splitDocuments(config, documents);
    logger.info(`Split into ${splitDocs.length} chunk(s)`);
    metadata.chunkCount = splitDocs.length;

    logger.info(`Using embedding config: "${embeddingConfigName}"`);

    // Test embeddings to ensure they work correctly
    if (splitDocs.length > 0) {
      const testDoc = splitDocs[0];
      if (!testDoc) {
        throw new Error('First document is undefined');
      }
      try {
        const testText = testDoc.pageContent.substring(0, 100);
        const testEmbedding = await embeddings.embedQuery(testText);
        if (!testEmbedding || testEmbedding.length === 0 || testEmbedding.some(v => !isFinite(v))) {
          throw new Error(`Embedding test failed: returned invalid values`);
        }
        logger.info(`Embedding test successful (dimension: ${testEmbedding.length})`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Embedding test failed: ${errorMessage}`);
        throw new Error(`Failed to create embeddings for knowledge store "${config.name}": ${errorMessage}`);
      }
    }

    onProgress?.({ name: config.name, phase: 'embedding', progress: 50, message: `Embedding ${splitDocs.length} chunks...` });
    logger.info(`Building knowledge store...`);
    const store = await MemoryVectorStore.fromDocuments(splitDocs, embeddings);
    logger.info(`Knowledge store "${config.name}" ready`);

    // Save to cache
    if (cacheDir) {
      onProgress?.({ name: config.name, phase: 'caching', progress: 90, message: 'Saving to cache...' });
      const sourceHashes = await this.computeFileHashes(config, projectRoot);
      metadata.sourceHashes = sourceHashes;
      const cache = new VectorStoreCache(cacheDir, config.name);
      await cache.save(store, embeddingConfigName, sourceHashes);
    }

    onProgress?.({ name: config.name, phase: 'done', progress: 100, message: 'Complete' });

    return this.wrapAsInstance(config, store, embeddings, metadata, projectRoot, cacheDir);
  }

  private static wrapAsInstance(
    config: VectorKnowledgeConfig,
    store: MemoryVectorStore,
    embeddings: Embeddings,
    metadata: KnowledgeStoreMetadata,
    projectRoot: string,
    cacheDir?: string
  ): KnowledgeStoreInstance {
    return {
      config,
      search: async (query: string, k?: number): Promise<SearchResult[]> => {
        const numResults = k ?? config.search?.defaultK ?? 4;
        searchLogger.info(`Searching "${config.name}" for: "${query.substring(0, 50)}..." (k=${numResults})`);

        try {
          // Expand short queries - some embedding models struggle with very short or terse text
          let searchQuery = query.trim();
          const wordCount = searchQuery.split(/\s+/).filter(w => w.length > 0).length;
          if (searchQuery.length < 30 || wordCount < 4) {
            searchLogger.warn(`Query is short (${searchQuery.length} chars, ${wordCount} words), expanding with context`);
            const storeContext = config.description
              ? `${config.description.toLowerCase()} information about`
              : 'information about';
            searchQuery = `${storeContext} ${searchQuery}`;
            searchLogger.info(`Expanded query: "${searchQuery}"`);
          }

          let queryEmbedding: number[] | null = null;
          try {
            queryEmbedding = await embeddings.embedQuery(searchQuery);
            if (queryEmbedding && queryEmbedding.length > 0) {
              const invalidValues = queryEmbedding.filter(v => !isFinite(v));
              const isZeroVector = queryEmbedding.every(v => v === 0);

              if (invalidValues.length > 0) {
                searchLogger.warn(`Validation embedding contains ${invalidValues.length} invalid values (NaN/Inf) - proceeding with search`);
              } else if (isZeroVector) {
                searchLogger.warn(`Validation embedding is a zero vector for query: "${searchQuery}"`);
                if (searchQuery !== query) {
                  searchLogger.warn(`Trying original query instead`);
                  try {
                    const originalEmbedding = await embeddings.embedQuery(query);
                    if (originalEmbedding && originalEmbedding.length > 0 && !originalEmbedding.every(v => v === 0)) {
                      searchQuery = query;
                      queryEmbedding = originalEmbedding;
                      searchLogger.info(`Original query embedding successful`);
                    }
                  } catch (e) {
                    // Keep using expanded query
                  }
                }
                searchLogger.warn(`Proceeding with search - MemoryVectorStore will embed the query internally`);
              } else {
                const norm = Math.sqrt(queryEmbedding.reduce((sum, v) => sum + v * v, 0));
                searchLogger.info(`Query validation successful (dimension: ${queryEmbedding.length}, norm: ${norm.toFixed(3)})`);
              }
            } else {
              searchLogger.warn(`Validation embedding returned empty array - proceeding with search`);
            }
          } catch (embedError) {
            const embedErrorMessage = embedError instanceof Error ? embedError.message : String(embedError);
            searchLogger.warn(`Query validation embedding failed: ${embedErrorMessage} - proceeding with search anyway`);
          }

          const results = await store.similaritySearchWithScore(searchQuery, numResults);

          const validResults = results.filter(([doc, score]) => {
            if (isNaN(score) || !isFinite(score)) {
              searchLogger.warn(`Invalid score detected: ${score} for document: "${doc.pageContent.substring(0, 50)}..."`);
              return false;
            }
            return true;
          });

          searchLogger.info(`Raw results: ${results.length}, valid: ${validResults.length}, scores: ${validResults.map(([, s]) => s.toFixed(3)).join(', ')}`);

          if (validResults.length === 0 && results.length > 0) {
            searchLogger.error(`All results have invalid scores - embedding API may be failing`);
            searchLogger.error(`This is a critical issue - returning empty results. Check embedding API at ${config.embedding}`);
            return [];
          }

          const threshold = config.search?.scoreThreshold;
          const filtered = validResults.filter(([, score]) => {
            if (threshold === undefined) return true;
            return score >= threshold;
          });
          searchLogger.info(`After threshold (${threshold ?? 'none'}): ${filtered.length} result(s)`);

          return filtered.map(([doc, score]) => ({
            content: doc.pageContent,
            metadata: doc.metadata,
            score,
          }));
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          searchLogger.error(`Error during search: ${errorMessage}`, error);
          return [];
        }
      },
      addDocuments: async (docs: DocumentInput[]): Promise<void> => {
        const storeDocs = docs.map((d) => ({
          pageContent: d.content,
          metadata: d.metadata ?? {},
        }));
        await store.addDocuments(storeDocs);
      },
      refresh: async (refreshOnProgress?: IndexingProgressCallback): Promise<void> => {
        refreshOnProgress?.({ name: config.name, phase: 'loading', progress: 10, message: 'Loading documents...' });
        const newDocs = await this.loadDocuments(config, projectRoot);
        const splitNewDocs = await this.splitDocuments(config, newDocs);
        refreshOnProgress?.({ name: config.name, phase: 'splitting', progress: 30, message: `Split into ${splitNewDocs.length} chunks...` });

        if (cacheDir) {
          const newSourceHashes = await this.computeFileHashes(config, projectRoot);
          const changedSources = new Set<string>();
          const removedSources = new Set<string>();

          for (const [source, hash] of Object.entries(newSourceHashes)) {
            if (metadata.sourceHashes[source] !== hash) {
              changedSources.add(source);
            }
          }
          for (const source of Object.keys(metadata.sourceHashes)) {
            if (!(source in newSourceHashes)) {
              removedSources.add(source);
            }
          }

          if (changedSources.size === 0 && removedSources.size === 0) {
            logger.info(`No changes detected for "${config.name}", skipping refresh`);
            return;
          }

          logger.info(`Refreshing "${config.name}": ${changedSources.size} changed, ${removedSources.size} removed`);
          refreshOnProgress?.({ name: config.name, phase: 'embedding', progress: 50, message: `Updating ${changedSources.size} changed sources...` });

          const sourcesToRemove = new Set([...changedSources, ...removedSources]);
          store.memoryVectors = store.memoryVectors.filter(
            (v) => !sourcesToRemove.has(v.metadata?.source as string ?? '')
          );

          const docsToAdd = splitNewDocs.filter(
            (doc) => changedSources.has(doc.metadata?.source as string ?? '')
          );

          if (docsToAdd.length > 0) {
            await store.addDocuments(docsToAdd);
          }

          metadata.sourceHashes = newSourceHashes;
          metadata.documentCount = newDocs.length;
          metadata.chunkCount = store.memoryVectors.length;

          refreshOnProgress?.({ name: config.name, phase: 'caching', progress: 90, message: 'Saving to cache...' });
          const cache = new VectorStoreCache(cacheDir, config.name);
          await cache.save(store, metadata.embeddingModel, newSourceHashes);
        } else {
          refreshOnProgress?.({ name: config.name, phase: 'embedding', progress: 50, message: `Re-embedding ${splitNewDocs.length} chunks...` });
          await store.addDocuments(splitNewDocs);
          metadata.documentCount = newDocs.length;
          metadata.chunkCount = splitNewDocs.length;
        }
      },
      getMetadata: () => ({ ...metadata }),
    };
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

  static async loadDocuments(config: KnowledgeConfig, projectRoot: string): Promise<Document[]> {
    if (config.source.type === 'database') {
      logger.info(`Loading from database source`);
      const dbLoader = new DatabaseLoader(config.source);
      return dbLoader.load();
    }

    if (config.source.type === 'web') {
      logger.info(`Loading from web source`);
      const webLoader = new WebLoader(config.source);
      return webLoader.load();
    }

    // Handle file-based sources (directory and file)
    const sourcePath = path.join(projectRoot, config.source.path);

    if (config.source.type === 'directory') {
      const pattern = config.source.pattern ?? '*';
      logger.info(`Searching for files in: ${sourcePath}`);
      logger.info(`Using pattern: ${pattern}`);
      const files = await glob(pattern, { cwd: sourcePath, absolute: true });
      logger.info(`Found ${files.length} file(s):`, files.map(f => path.basename(f)));

      const allDocs: Document[] = [];
      for (const file of files) {
        const loader = this.createLoader(config.loader.type, file);
        const docs = await loader.load();
        logger.info(`Loaded ${docs.length} doc(s) from ${path.basename(file)}`);
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
      case 'pdf':
        return new PDFLoader(filePath);
      case 'csv':
        return new CSVLoader(filePath);
      case 'json':
        return new JSONLoader(filePath);
      case 'text':
      case 'markdown':
      default:
        return new TextLoader(filePath);
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

  static createEmbeddings(configName: string): Embeddings {
    const embeddingConfig = getEmbeddingConfig(configName);
    const provider = detectProvider(embeddingConfig);

    const eosToken = embeddingConfig.eosToken;

    logger.info(`Embedding model: ${embeddingConfig.model} (provider: ${provider})${embeddingConfig.baseUrl ? `, URL: ${embeddingConfig.baseUrl}` : ''}`);
    if (eosToken) {
      logger.info(`Using EOS token: "${eosToken}"`);
    }

    let baseEmbeddings: Embeddings;

    switch (provider) {
      case 'gemini':
        logger.info('Creating Gemini embeddings');
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

        logger.info(`Creating OpenAI-compatible embeddings (encoding: float)${embeddingConfig.dimensions ? ` (dimensions: ${embeddingConfig.dimensions})` : ''}`);
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
      if (!eosToken) return text;
      if (text.endsWith(eosToken)) {
        return text;
      }
      return `${text}${eosToken}`;
    };

    const validateEmbedding = (result: number[], context: string): number[] => {
      if (!Array.isArray(result) || result.length === 0) {
        throw new Error(`${context}: Embedding returned invalid format - expected array of numbers, got ${typeof result}`);
      }
      if (result.some(v => typeof v !== 'number')) {
        throw new Error(`${context}: Embedding contains non-numeric values`);
      }
      if (result.some(v => !isFinite(v))) {
        throw new Error(`${context}: Embedding contains NaN or Infinity values`);
      }
      const isZeroVector = result.every(v => v === 0);
      if (isZeroVector) {
        throw new Error(`${context}: Embedding returned a zero vector - API may have failed or returned invalid data`);
      }
      return result;
    };

    const validateEmbeddings = (result: number[][], context: string): number[][] => {
      if (!Array.isArray(result)) {
        throw new Error(`${context}: Embedding returned invalid format - expected array of arrays`);
      }
      return result.map((embedding, idx) => validateEmbedding(embedding, `${context}[${idx}]`));
    };

    const originalEmbedQuery = embeddings.embedQuery.bind(embeddings);
    const originalEmbedDocuments = embeddings.embedDocuments.bind(embeddings);

    return {
      embedQuery: async (text: string): Promise<number[]> => {
        try {
          const processedText = appendToken(text);
          const result = await originalEmbedQuery(processedText);
          return validateEmbedding(result, 'embedQuery');
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error(`Embedding query failed for text: "${text.substring(0, 50)}..."`);
          logger.error(`Error: ${errorMessage}`);
          throw new Error(`Embedding query failed: ${errorMessage}`);
        }
      },
      embedDocuments: async (texts: string[]): Promise<number[][]> => {
        try {
          const processedTexts = texts.map(appendToken);
          const result = await originalEmbedDocuments(processedTexts);
          return validateEmbeddings(result, 'embedDocuments');
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error(`Embedding documents failed for ${texts.length} text(s)`);
          logger.error(`Error: ${errorMessage}`);
          throw new Error(`Embedding documents failed: ${errorMessage}`);
        }
      },
    };
  }
}
