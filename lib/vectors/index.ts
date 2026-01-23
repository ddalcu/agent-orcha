export { VectorStoreFactory } from './vector-store-factory.js';
export { VectorStoreManager } from './vector-store-manager.js';
export {
  VectorConfigSchema,
  SourceConfigSchema,
  DirectorySourceConfigSchema,
  FileSourceConfigSchema,
  DatabaseSourceConfigSchema,
  WebSourceConfigSchema,
  S3SourceConfigSchema,
  LoaderConfigSchema,
  SplitterConfigSchema,
  EmbeddingRefSchema,
  StoreConfigSchema,
  SearchConfigSchema,
} from './types.js';
export type {
  VectorConfig,
  SourceConfig,
  DirectorySourceConfig,
  FileSourceConfig,
  DatabaseSourceConfig,
  WebSourceConfig,
  S3SourceConfig,
  LoaderConfig,
  SplitterConfig,
  StoreConfig,
  SearchConfig,
  SearchResult,
  DocumentInput,
  VectorStoreInstance,
} from './types.js';
export { DatabaseLoader, WebLoader, S3Loader } from './loaders/index.js';
export { getPool, closeAllPools, getDatabaseType, detectFileType, isSupportedFileType } from './utils/index.js';
