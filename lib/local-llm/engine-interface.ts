export interface EngineServerStatus {
  running: boolean;
  activeModel: string | null;
  port: number | null;
  contextSize: number | null;
  memoryEstimate: { modelBytes: number; kvCacheBytes: number; totalBytes: number } | null;
}

export interface EngineChatStatus extends EngineServerStatus {
  supportsVision: boolean;
  mmprojBytes: number;
}

export interface EngineStatus {
  engineName: string;
  available: boolean;
  chat: EngineChatStatus;
  embedding: EngineServerStatus;
}

export interface LoadOptions {
  contextSize?: number;
  reasoningBudget?: number;
}

export interface LocalEngine {
  readonly engineName: string;
  isAvailable(): boolean;
  setBaseDir(dir: string): void;

  // Chat
  loadChat(modelPath: string, opts?: LoadOptions): Promise<void>;
  unloadChat(): Promise<void>;
  swapChat(modelPath: string, opts?: LoadOptions): Promise<void>;
  ensureRunningChat(modelName: string, opts?: LoadOptions): Promise<void>;
  getChatStatus(): EngineChatStatus;
  getChatBaseUrl(): string | null;

  // Embedding
  loadEmbedding(modelPath: string): Promise<void>;
  unloadEmbedding(): Promise<void>;
  ensureRunningEmbedding(modelName: string): Promise<void>;
  getEmbeddingStatus(): EngineServerStatus;
  getEmbeddingBaseUrl(): string | null;

  // Combined
  getStatus(): EngineStatus;
  killOrphans(): void;

  // Binary management
  getBinaryVersion(): string | null;
  getBinarySource(): 'managed' | 'system' | null;
  checkForUpdate(): Promise<any>;
  updateBinary(): Promise<void>;
}
