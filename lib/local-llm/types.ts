export interface LocalModel {
  id: string;
  fileName: string;
  filePath: string;
  sizeBytes: number;
  repo?: string;
  downloadedAt: string;
  modelType?: 'llm' | 'image' | 'tts' | 'stt';
}

export interface HuggingFaceGgufFile {
  fileName: string;
  sizeBytes: number;
}

export interface HuggingFaceModelResult {
  repoId: string;
  author: string;
  modelName: string;
  likes: number;
  downloads: number;
  tags: string[];
  pipelineTag: string;
  ggufFiles: HuggingFaceGgufFile[];
}

export interface DownloadProgress {
  fileName: string;
  downloadedBytes: number;
  totalBytes: number;
  percent: number;
}

export interface ActiveDownload {
  repo: string;
  fileName: string;
  progress: DownloadProgress;
}

export interface InterruptedDownload {
  fileName: string;
  repo?: string;
  downloadedBytes: number;
}

export interface LocalLlmState {
  lastActiveModel: string | null;
  port?: number;
}
