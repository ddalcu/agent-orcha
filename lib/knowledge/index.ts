export { KnowledgeStoreFactory } from './knowledge-store-factory.js';
export { KnowledgeStoreManager } from './knowledge-store-manager.js';
export { KnowledgeMetadataManager, createDefaultMetadata } from './knowledge-store-metadata.js';
export {
  KnowledgeConfigSchema,
  VectorKnowledgeConfigSchema,
  GraphRagKnowledgeConfigSchema,
  SourceConfigSchema,
  DirectorySourceConfigSchema,
  FileSourceConfigSchema,
  DatabaseSourceConfigSchema,
  WebSourceConfigSchema,
  LoaderConfigSchema,
  SplitterConfigSchema,
  EmbeddingRefSchema,
  StoreConfigSchema,
  SearchConfigSchema,
} from './types.js';
export type {
  KnowledgeConfig,
  VectorKnowledgeConfig,
  GraphRagKnowledgeConfig,
  SourceConfig,
  DirectorySourceConfig,
  FileSourceConfig,
  DatabaseSourceConfig,
  WebSourceConfig,
  LoaderConfig,
  SplitterConfig,
  StoreConfig,
  SearchConfig,
  SearchResult,
  DocumentInput,
  KnowledgeStoreInstance,
  KnowledgeStoreMetadata,
  KnowledgeStoreStatus,
  IndexingProgressEvent,
  IndexingProgressCallback,
  IndexingPhase,
} from './types.js';
export { DatabaseLoader, WebLoader, TextLoader, JSONLoader, CSVLoader, PDFLoader } from './loaders/index.js';
export { getPool, closeAllPools, getDatabaseType, detectFileType, isSupportedFileType } from './utils/index.js';

// Graph RAG exports
export { GraphRagFactory } from './graph-rag/index.js';
export type {
  GraphNode,
  GraphEdge,
  Community,
  GraphStore,
  GraphConfig,
  GraphSearchConfig,
} from './graph-rag/index.js';
