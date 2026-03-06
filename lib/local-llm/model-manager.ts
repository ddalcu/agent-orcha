import * as fs from 'fs/promises';
import * as path from 'path';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { logger } from '../logger.ts';
import type {
  LocalModel,
  LocalLlmState,
  HuggingFaceModelResult,
  DownloadProgress,
  ActiveDownload,
  InterruptedDownload,
} from './types.ts';

const STATE_FILE = 'state.json';

export class ModelManager {
  private modelsDir: string;
  private _activeDownloads = new Map<string, ActiveDownload>();

  constructor(workspaceRoot: string) {
    this.modelsDir = path.join(workspaceRoot, '.models');
  }

  getActiveDownloads(): ActiveDownload[] {
    return [...this._activeDownloads.values()];
  }

  /** Find .downloading partial files that aren't currently being downloaded (interrupted by restart etc.) */
  async getInterruptedDownloads(): Promise<InterruptedDownload[]> {
    await this.ensureDir();
    const entries = await fs.readdir(this.modelsDir);
    const results: InterruptedDownload[] = [];

    for (const entry of entries) {
      if (!entry.endsWith('.gguf.downloading')) continue;
      const fileName = entry.replace(/\.downloading$/, '');
      // Skip if this file is currently being downloaded
      const isActive = [...this._activeDownloads.values()].some(d => d.fileName === fileName);
      if (isActive) continue;

      const filePath = path.join(this.modelsDir, entry);
      const stat = await fs.stat(filePath);
      const meta = await this.readMeta(fileName);

      results.push({
        fileName,
        repo: meta?.repo,
        downloadedBytes: stat.size,
      });
    }
    return results;
  }

  async deleteInterruptedDownload(fileName: string): Promise<void> {
    const tempPath = path.join(this.modelsDir, `${fileName}.downloading`);
    await fs.unlink(tempPath).catch(() => {});
    await fs.unlink(this.metaPath(fileName)).catch(() => {});
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.modelsDir, { recursive: true });
  }

  async listModels(): Promise<LocalModel[]> {
    await this.ensureDir();
    const entries = await fs.readdir(this.modelsDir);
    const models: LocalModel[] = [];

    for (const entry of entries) {
      if (!entry.endsWith('.gguf')) continue;
      const filePath = path.join(this.modelsDir, entry);
      const stat = await fs.stat(filePath);
      const meta = await this.readMeta(entry);

      models.push({
        id: this.fileNameToId(entry),
        fileName: entry,
        filePath,
        sizeBytes: stat.size,
        repo: meta?.repo,
        downloadedAt: meta?.downloadedAt ?? stat.birthtime.toISOString(),
      });
    }

    return models;
  }

  async getModel(id: string): Promise<LocalModel | null> {
    const models = await this.listModels();
    return models.find((m) => m.id === id) ?? null;
  }

  async findModelFile(modelName: string): Promise<string | null> {
    const models = await this.listModels();
    const match = models.find((m) => m.id === modelName || m.fileName === modelName);
    return match?.filePath ?? null;
  }

  async downloadModel(
    repo: string,
    fileName: string,
    onProgress?: (progress: DownloadProgress) => void,
  ): Promise<LocalModel> {
    const downloadKey = `${repo}/${fileName}`;

    // If already downloading, don't start again
    if (this._activeDownloads.has(downloadKey)) {
      throw new Error(`Already downloading ${downloadKey}`);
    }

    await this.ensureDir();

    const url = `https://huggingface.co/${repo}/resolve/main/${fileName}`;
    const tempPath = path.join(this.modelsDir, `${fileName}.downloading`);
    const finalPath = path.join(this.modelsDir, fileName);

    // Check for a partial download to resume
    let existingBytes = 0;
    try {
      const stat = await fs.stat(tempPath);
      existingBytes = stat.size;
    } catch { /* no partial file */ }

    const resuming = existingBytes > 0;
    if (resuming) {
      logger.info(`[ModelManager] Resuming download of ${fileName} from ${existingBytes} bytes`);
    } else {
      logger.info(`[ModelManager] Downloading ${url}`);
    }

    // Write meta early so interrupted downloads know which repo they belong to
    await fs.writeFile(this.metaPath(fileName), JSON.stringify({ repo }, null, 2));

    const initialProgress: DownloadProgress = { fileName, downloadedBytes: existingBytes, totalBytes: 0, percent: 0 };
    this._activeDownloads.set(downloadKey, { repo, fileName, progress: initialProgress });

    try {
      const headers: Record<string, string> = {};
      if (resuming) {
        headers['Range'] = `bytes=${existingBytes}-`;
      }

      const response = await fetch(url, { redirect: 'follow', headers });

      // 416 = Range Not Satisfiable — file is already complete
      if (response.status === 416) {
        await fs.rename(tempPath, finalPath);
        const meta = { repo, downloadedAt: new Date().toISOString() };
        await fs.writeFile(this.metaPath(fileName), JSON.stringify(meta, null, 2));
        const stat = await fs.stat(finalPath);
        return {
          id: this.fileNameToId(fileName),
          fileName,
          filePath: finalPath,
          sizeBytes: stat.size,
          repo,
          downloadedAt: meta.downloadedAt,
        };
      }

      if (!response.ok && response.status !== 206) {
        throw new Error(`Download failed: ${response.status} ${response.statusText}`);
      }

      // 206 = Partial Content (resume), 200 = full file (server doesn't support range or fresh start)
      const isPartial = response.status === 206;
      const contentLength = Number(response.headers.get('content-length') ?? 0);
      const totalBytes = isPartial ? existingBytes + contentLength : contentLength;
      let downloadedBytes = isPartial ? existingBytes : 0;

      // If server returned 200 instead of 206, start from scratch
      if (!isPartial && resuming) {
        existingBytes = 0;
        downloadedBytes = 0;
      }

      const body = response.body;
      if (!body) throw new Error('No response body');

      const fileStream = createWriteStream(tempPath, {
        flags: isPartial ? 'a' : 'w',
      });
      const activeDownloads = this._activeDownloads;

      const progressStream = new TransformStream({
        transform(chunk, controller) {
          downloadedBytes += chunk.byteLength;
          const progress: DownloadProgress = {
            fileName,
            downloadedBytes,
            totalBytes,
            percent: totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0,
          };
          const entry = activeDownloads.get(downloadKey);
          if (entry) entry.progress = progress;
          onProgress?.(progress);
          controller.enqueue(chunk);
        },
      });

      const readable = body.pipeThrough(progressStream);

      const nodeReadable = await import('stream');
      const nodeStream = nodeReadable.Readable.fromWeb(readable as any);
      await pipeline(nodeStream, fileStream);

      await fs.rename(tempPath, finalPath);

      const meta = { repo, downloadedAt: new Date().toISOString() };
      await fs.writeFile(this.metaPath(fileName), JSON.stringify(meta, null, 2));

      const stat = await fs.stat(finalPath);
      return {
        id: this.fileNameToId(fileName),
        fileName,
        filePath: finalPath,
        sizeBytes: stat.size,
        repo,
        downloadedAt: meta.downloadedAt,
      };
    } finally {
      this._activeDownloads.delete(downloadKey);
    }
  }

  async deleteModel(id: string): Promise<void> {
    const model = await this.getModel(id);
    if (!model) throw new Error(`Model "${id}" not found`);

    await fs.unlink(model.filePath);
    try {
      await fs.unlink(this.metaPath(model.fileName));
    } catch {
      // meta file may not exist
    }
  }

  async browseHuggingFace(query: string, limit = 10): Promise<HuggingFaceModelResult[]> {
    // Strip HuggingFace URL prefixes so users can paste links directly
    let cleaned = query.replace(/^https?:\/\/huggingface\.co\//, '').replace(/\/$/, '');

    // If query looks like "author/model" (no GGUF suffix), also search by model name
    // to find community GGUF quants (e.g. "Qwen/Qwen3.5-9B" -> also search "Qwen3.5-9B")
    const searches: string[] = [cleaned];
    if (/^[^/]+\/[^/]+$/.test(cleaned) && !cleaned.toLowerCase().includes('gguf')) {
      searches.push(cleaned.split('/')[1]);
    }

    const seen = new Set<string>();
    let models: any[] = [];
    for (const q of searches) {
      const url = `https://huggingface.co/api/models?search=${encodeURIComponent(q)}&filter=gguf&sort=downloads&direction=-1&limit=${limit}`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HuggingFace API error: ${response.status}`);
      }
      const batch: any[] = await response.json();
      for (const m of batch) {
        const id = m.modelId ?? m.id;
        if (!seen.has(id)) {
          seen.add(id);
          models.push(m);
        }
      }
    }
    // Re-sort merged results by downloads and cap at limit
    models.sort((a: any, b: any) => (b.downloads ?? 0) - (a.downloads ?? 0));
    models = models.slice(0, limit);
    const results: HuggingFaceModelResult[] = [];

    for (const model of models) {
      // Fetch detailed info (file list + pipeline_tag) for each model
      let ggufFiles: { fileName: string; sizeBytes: number }[] = [];
      let pipelineTag = model.pipeline_tag ?? '';
      let detailTags: string[] = [];
      try {
        const detailUrl = `https://huggingface.co/api/models/${model.modelId}?blobs=true`;
        const detailRes = await fetch(detailUrl);
        if (detailRes.ok) {
          const detail = await detailRes.json();
          pipelineTag = detail.pipeline_tag ?? pipelineTag;
          detailTags = Array.isArray(detail.tags) ? detail.tags : [];
          const siblings = detail.siblings ?? [];
          ggufFiles = siblings
            .filter((s: any) => s.rfilename?.endsWith('.gguf'))
            .map((s: any) => ({
              fileName: s.rfilename,
              sizeBytes: s.size ?? 0,
            }));
        }
      } catch {
        // Skip on error
      }

      // Merge tags from list and detail responses
      const listTags: string[] = Array.isArray(model.tags) ? model.tags : [];
      const allTags = [...new Set([...listTags, ...detailTags])];

      results.push({
        repoId: model.modelId ?? model.id,
        author: model.author ?? model.modelId?.split('/')[0] ?? '',
        modelName: model.modelId?.split('/')[1] ?? model.modelId,
        likes: model.likes ?? 0,
        downloads: model.downloads ?? 0,
        tags: allTags,
        pipelineTag,
        ggufFiles,
      });
    }

    return results;
  }

  async getState(): Promise<LocalLlmState> {
    try {
      const content = await fs.readFile(path.join(this.modelsDir, STATE_FILE), 'utf-8');
      return JSON.parse(content);
    } catch {
      return { lastActiveModel: null };
    }
  }

  async saveState(state: LocalLlmState): Promise<void> {
    await this.ensureDir();
    await fs.writeFile(
      path.join(this.modelsDir, STATE_FILE),
      JSON.stringify(state, null, 2),
    );
  }

  private fileNameToId(fileName: string): string {
    return fileName.replace(/\.gguf$/, '');
  }

  private metaPath(fileName: string): string {
    return path.join(this.modelsDir, `${fileName}.meta.json`);
  }

  private async readMeta(fileName: string): Promise<{ repo?: string; downloadedAt?: string } | null> {
    try {
      const content = await fs.readFile(this.metaPath(fileName), 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }
}
