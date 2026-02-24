export { KnowledgeStore } from './knowledge-store.ts';
export { SqliteStore } from './sqlite-store.ts';
export { DirectMapper } from './direct-mapper.ts';
export { KnowledgeMetadataManager, createDefaultMetadata } from './knowledge-store-metadata.ts';

// Backward compatibility alias
export { KnowledgeStore as KnowledgeStoreManager } from './knowledge-store.ts';

export {
  KnowledgeConfigSchema,
  SourceConfigSchema,
  DirectorySourceConfigSchema,
  FileSourceConfigSchema,
  DatabaseSourceConfigSchema,
  WebSourceConfigSchema,
  LoaderConfigSchema,
  SplitterConfigSchema,
  EmbeddingRefSchema,
  SearchConfigSchema,
  GraphConfigSchema,
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
  SearchConfig,
  SearchResult,
  DocumentInput,
  KnowledgeStoreInstance,
  KnowledgeStoreMetadata,
  KnowledgeStoreStatus,
  IndexingProgressEvent,
  IndexingProgressCallback,
  IndexingPhase,
  GraphConfig,
  ExtractedEntity,
  ExtractedRelationship,
  ExtractionResult,
  EntityMapping,
  RelationshipMapping,
  DirectMappingConfig,
} from './types.ts';

export { DatabaseLoader, WebLoader, TextLoader, JSONLoader, CSVLoader, PDFLoader } from './loaders/index.ts';
export { getPool, closeAllPools, getDatabaseType, detectFileType, isSupportedFileType } from './utils/index.ts';
