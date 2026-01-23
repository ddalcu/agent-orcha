import { MemoryVectorStore } from '@langchain/classic/vectorstores/memory';
import { Chroma } from '@langchain/community/vectorstores/chroma';
import { OpenAIEmbeddings } from '@langchain/openai';
import { GoogleGenerativeAIEmbeddings } from '@langchain/google-genai';
import { TextLoader } from '@langchain/classic/document_loaders/fs/text';
import { PDFLoader } from '@langchain/community/document_loaders/fs/pdf';
import { CSVLoader } from '@langchain/community/document_loaders/fs/csv';
import { JSONLoader } from '@langchain/classic/document_loaders/fs/json';
import { CharacterTextSplitter, RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { glob } from 'glob';
import * as path from 'path';
import type { Document } from '@langchain/core/documents';
import type { Embeddings } from '@langchain/core/embeddings';
import type { VectorStore } from '@langchain/core/vectorstores';
import type { VectorConfig, VectorStoreInstance, SearchResult, DocumentInput } from './types.js';
import { getEmbeddingConfig } from '../llm/llm-config.js';
import { detectProvider } from '../llm/provider-detector.js';
import { createLogger } from '../logger.js';
import { DatabaseLoader, WebLoader, S3Loader } from './loaders/index.js';

const logger = createLogger('VectorFactory');
const searchLogger = createLogger('VectorSearch');

export class VectorStoreFactory {
  static async create(config: VectorConfig, projectRoot: string): Promise<VectorStoreInstance> {
    logger.info(`Loading documents for "${config.name}"...`);
    const documents = await this.loadDocuments(config, projectRoot);
    logger.info(`Loaded ${documents.length} document(s)`);

    const splitDocs = await this.splitDocuments(config, documents);
    logger.info(`Split into ${splitDocs.length} chunk(s)`);

    const embeddingConfigName = config.embedding;
    logger.info(`Using embedding config: "${embeddingConfigName}"`);
    const embeddings = this.createEmbeddings(embeddingConfigName);

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
        throw new Error(`Failed to create embeddings for vector store "${config.name}": ${errorMessage}`);
      }
    }

    logger.info(`Building vector store...`);
    const store = await this.createStore(config, splitDocs, embeddings, projectRoot);
    logger.info(`Vector store "${config.name}" ready`);

    return {
      config,
      search: async (query: string, k?: number): Promise<SearchResult[]> => {
        const numResults = k ?? config.search?.defaultK ?? 4;
        searchLogger.info(`Searching "${config.name}" for: "${query.substring(0, 50)}..." (k=${numResults})`);

        try {
          // Expand short queries - some embedding models struggle with very short or terse text
          // Expand if less than 30 chars or less than 4 words to ensure better embedding quality
          let searchQuery = query.trim();
          const wordCount = searchQuery.split(/\s+/).filter(w => w.length > 0).length;
          if (searchQuery.length < 30 || wordCount < 4) {
            searchLogger.warn(`Query is short (${searchQuery.length} chars, ${wordCount} words), expanding with context`);
            // Add context based on the vector store description to make query more descriptive
            const storeContext = config.description 
              ? `${config.description.toLowerCase()} information about`
              : 'information about';
            searchQuery = `${storeContext} ${searchQuery}`;
            searchLogger.info(`Expanded query: "${searchQuery}"`);
          }

          // Note: We validate the embedding here for diagnostics, but MemoryVectorStore
          // will embed the query again internally. If our validation fails but the store's
          // embedding works, we'll still get results.
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
                // Try with original query if we expanded it
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
            // Don't return - let MemoryVectorStore try embedding internally
          }

          // MemoryVectorStore will embed the query internally using its stored embeddings instance
          // Use the query that worked best (original or expanded)
          const results = await store.similaritySearchWithScore(searchQuery, numResults);

          // Filter out NaN scores and log warnings with more details
          const validResults = results.filter(([doc, score]) => {
            if (isNaN(score) || !isFinite(score)) {
              searchLogger.warn(`Invalid score detected: ${score} for document: "${doc.pageContent.substring(0, 50)}..."`);
              return false;
            }
            return true;
          });

          searchLogger.info(`Raw results: ${results.length}, valid: ${validResults.length}, scores: ${validResults.map(([, s]) => s.toFixed(3)).join(', ')}`);

          // If all results have NaN scores, this indicates the embedding API failed
          // Try a fallback: return all documents with a low score so the agent at least gets some context
          if (validResults.length === 0 && results.length > 0) {
            searchLogger.error(`All results have invalid scores - embedding API may be failing`);
            searchLogger.error(`This is a critical issue - returning empty results. Check embedding API at ${config.embedding}`);
            // Return empty - the agent will need to handle this
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
        const langchainDocs = docs.map((d) => ({
          pageContent: d.content,
          metadata: d.metadata ?? {},
        }));
        await store.addDocuments(langchainDocs);
      },
      refresh: async (): Promise<void> => {
        const newDocs = await this.loadDocuments(config, projectRoot);
        const splitNewDocs = await this.splitDocuments(config, newDocs);
        await store.addDocuments(splitNewDocs);
      },
    };
  }

  private static async loadDocuments(config: VectorConfig, projectRoot: string): Promise<Document[]> {
    // Handle database sources
    if (config.source.type === 'database') {
      logger.info(`Loading from database source`);
      const dbLoader = new DatabaseLoader(config.source);
      return dbLoader.load();
    }

    // Handle web sources
    if (config.source.type === 'web') {
      logger.info(`Loading from web source`);
      const webLoader = new WebLoader(config.source);
      return webLoader.load();
    }

    // Handle S3 sources
    if (config.source.type === 's3') {
      logger.info(`Loading from S3 source`);
      const s3Loader = new S3Loader(config.source);
      return s3Loader.load();
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

    // Handle single file source
    if (config.source.type === 'file') {
      const loader = this.createLoader(config.loader.type, sourcePath);
      return loader.load();
    }

    // This should never be reached due to discriminated union exhaustiveness
    const _exhaustiveCheck: never = config.source;
    throw new Error(`Unknown source type: ${(_exhaustiveCheck as any).type}`);
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

  private static async splitDocuments(config: VectorConfig, documents: Document[]): Promise<Document[]> {
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

  private static createEmbeddings(configName: string): Embeddings {
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
        baseEmbeddings = new GoogleGenerativeAIEmbeddings({
          modelName: embeddingConfig.model,
          apiKey: embeddingConfig.apiKey,
        });
        break;
      case 'openai':
      case 'local':
      case 'anthropic':
      default: {
        const openAIConfig: any = {
          modelName: embeddingConfig.model,
          openAIApiKey: embeddingConfig.apiKey,
          configuration: embeddingConfig.baseUrl ? { baseURL: embeddingConfig.baseUrl } : undefined,
          // CRITICAL: Force float encoding to get number arrays instead of base64 strings
          // LM Studio and other local servers need this to return valid embeddings
          encodingFormat: 'float',
        };

        // Add dimensions if specified
        if (embeddingConfig.dimensions) {
          openAIConfig.dimensions = embeddingConfig.dimensions;
        }

        logger.info(`Creating OpenAI-compatible embeddings (encoding: float)${embeddingConfig.dimensions ? ` (dimensions: ${embeddingConfig.dimensions})` : ''}`);
        baseEmbeddings = new OpenAIEmbeddings(openAIConfig);
        break;
      }
    }

    // Wrap embeddings to add validation and EOS token support
    return this.wrapWithValidation(baseEmbeddings, eosToken);
  }

  /**
   * Wraps embeddings with validation and optional EOS token support
   */
  private static wrapWithValidation(embeddings: Embeddings, eosToken?: string): Embeddings {
    const appendToken = (text: string): string => {
      if (!eosToken) return text;
      // Only append if not already present
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
      // Check for zero vector (usually indicates API failure)
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

    // Store original methods
    const originalEmbedQuery = embeddings.embedQuery.bind(embeddings);
    const originalEmbedDocuments = embeddings.embedDocuments.bind(embeddings);

    // Override with validation
    embeddings.embedQuery = async (text: string): Promise<number[]> => {
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
    };

    embeddings.embedDocuments = async (texts: string[]): Promise<number[][]> => {
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
    };

    return embeddings;
  }


  private static async createStore(
    config: VectorConfig,
    docs: Document[],
    embeddings: Embeddings,
    projectRoot: string
  ): Promise<VectorStore> {
    switch (config.store.type) {
      case 'chroma': {
        const chromaPath = config.store.options?.path
          ? path.resolve(projectRoot, config.store.options.path as string)
          : path.resolve(projectRoot, '.chroma');

        const collectionName = config.store.options?.collectionName as string ?? config.name;
        const url = config.store.options?.url as string ?? 'http://localhost:8000';

        logger.info(`Using Chroma at ${url} (collection: ${collectionName}, path: ${chromaPath})`);

        return Chroma.fromDocuments(docs, embeddings, {
          collectionName,
          url,
          collectionMetadata: {
            'hnsw:space': 'cosine',
          },
        });
      }

      case 'memory':
        return MemoryVectorStore.fromDocuments(docs, embeddings);

      case 'pinecone':
      case 'qdrant':
        logger.warn(`Store type "${config.store.type}" not yet implemented, falling back to memory`);
        return MemoryVectorStore.fromDocuments(docs, embeddings);

      default:
        logger.warn(`Unknown store type "${config.store.type}", falling back to memory`);
        return MemoryVectorStore.fromDocuments(docs, embeddings);
    }
  }
}
