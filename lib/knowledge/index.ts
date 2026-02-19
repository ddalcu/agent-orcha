export { KnowledgeStoreFactory } from './knowledge-store-factory.ts';
export { KnowledgeStoreManager } from './knowledge-store-manager.ts';
export { KnowledgeMetadataManager, createDefaultMetadata } from './knowledge-store-metadata.ts';
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
} from './types.ts';
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
} from './types.ts';
export { DatabaseLoader, WebLoader, TextLoader, JSONLoader, CSVLoader, PDFLoader } from './loaders/index.ts';
export { getPool, closeAllPools, getDatabaseType, detectFileType, isSupportedFileType } from './utils/index.ts';

// Graph RAG exports
export { GraphRagFactory } from './graph-rag/index.ts';
export type {
  GraphNode,
  GraphEdge,
  Community,
  GraphStore,
  GraphConfig,
  GraphSearchConfig,
} from './graph-rag/index.ts';
