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
      // GGUF partial downloads
      if (entry.endsWith('.gguf.downloading')) {
        const fileName = entry.replace(/\.downloading$/, '');
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
        continue;
      }

      // MLX partial downloads (directories with .downloading marker)
      const markerPath = path.join(this.modelsDir, entry, '.downloading');
      try {
        await fs.stat(markerPath);
      } catch { continue; }

      const isActive = [...this._activeDownloads.values()].some(d => d.fileName === entry);
      if (isActive) continue;

      const dirSize = await this.dirSize(path.join(this.modelsDir, entry));
      const meta = await this.readMlxMeta(entry);

      results.push({
        fileName: entry,
        repo: meta?.repo,
        downloadedBytes: dirSize,
      });
    }
    return results;
  }

  async deleteInterruptedDownload(fileName: string): Promise<void> {
    // Check if it's an MLX directory with .downloading marker
    const dirPath = path.join(this.modelsDir, fileName);
    try {
      const stat = await fs.stat(dirPath);
      if (stat.isDirectory()) {
        await fs.rm(dirPath, { recursive: true });
        return;
      }
    } catch { /* not a directory */ }

    // GGUF partial download
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
      const entryPath = path.join(this.modelsDir, entry);
      const stat = await fs.stat(entryPath);

      // GGUF files
      if (entry.endsWith('.gguf') && stat.isFile()) {
        if (entry.toLowerCase().includes('mmproj')) continue;
        const meta = await this.readMeta(entry);
        models.push({
          id: this.fileNameToId(entry),
          fileName: entry,
          filePath: entryPath,
          sizeBytes: stat.size,
          repo: meta?.repo,
          downloadedAt: meta?.downloadedAt ?? stat.birthtime.toISOString(),
          type: 'gguf',
        });
        continue;
      }

      // MLX model directories (contain config.json)
      if (stat.isDirectory()) {
        const configPath = path.join(entryPath, 'config.json');
        try {
          await fs.stat(configPath);
        } catch { continue; }

        // Skip directories with .downloading marker (incomplete)
        try {
          await fs.stat(path.join(entryPath, '.downloading'));
          continue;
        } catch { /* no marker = complete */ }

        const meta = await this.readMlxMeta(entry);
        const sizeBytes = await this.dirSize(entryPath);
        models.push({
          id: entry,
          fileName: entry,
          filePath: entryPath,
          sizeBytes,
          repo: meta?.repo,
          downloadedAt: meta?.downloadedAt ?? stat.birthtime.toISOString(),
          type: 'mlx',
        });
      }
    }

    return models;
  }

  async getModel(id: string): Promise<LocalModel | null> {
    const models = await this.listModels();
    return models.find((m) => m.id === id) ?? null;
  }

  /** Auto-download an mmproj file from the same repo if needed for vision support. */
  async autoDownloadMmproj(
    repo: string,
    onProgress?: (progress: DownloadProgress) => void,
  ): Promise<LocalModel | null> {
    await this.ensureDir();

    // Already have an mmproj from this repo?
    const entries = await fs.readdir(this.modelsDir);
    for (const entry of entries) {
      if (!entry.toLowerCase().includes('mmproj') || !entry.endsWith('.gguf')) continue;
      const meta = await this.readMeta(entry);
      if (meta?.repo === repo) return null;
    }

    // Fetch repo file list from HuggingFace
    try {
      const res = await fetch(`https://huggingface.co/api/models/${repo}?blobs=true`);
      if (!res.ok) return null;
      const detail: any = await res.json();

      const mmprojFiles = (detail.siblings ?? [])
        .filter((s: any) => s.rfilename?.endsWith('.gguf') && s.rfilename.toLowerCase().includes('mmproj'))
        .map((s: any) => ({ fileName: s.rfilename as string, sizeBytes: (s.size ?? 0) as number }));

      if (mmprojFiles.length === 0) return null;

      // Prefer F16/BF16 (smaller, good quality) over F32
      const preferred = mmprojFiles.find((f: { fileName: string }) =>
        /f16|bf16/i.test(f.fileName) && !/f32/i.test(f.fileName)
      ) ?? mmprojFiles[0];

      logger.info(`[ModelManager] Auto-downloading mmproj: ${preferred.fileName} from ${repo}`);
      return this.downloadModel(repo, preferred.fileName, onProgress);
    } catch (err) {
      logger.warn(`[ModelManager] Failed to auto-download mmproj: ${err}`);
      return null;
    }
  }

  async findModelFile(modelName: string): Promise<{ filePath: string; type: 'gguf' | 'mlx' } | null> {
    const models = await this.listModels();
    const match = models.find((m) => m.id === modelName || m.fileName === modelName);
    return match ? { filePath: match.filePath, type: match.type } : null;
  }

  /** Find a multimodal projector (mmproj) file from the same repo as the given model. */
  async findMmprojForModel(modelFileName: string): Promise<string | null> {
    const modelMeta = await this.readMeta(modelFileName);
    if (!modelMeta?.repo) return null;

    await this.ensureDir();
    const entries = await fs.readdir(this.modelsDir);

    for (const entry of entries) {
      if (!entry.toLowerCase().includes('mmproj') || !entry.endsWith('.gguf')) continue;
      const meta = await this.readMeta(entry);
      if (meta?.repo === modelMeta.repo) return path.join(this.modelsDir, entry);
    }

    return null;
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
          type: 'gguf' as const,
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
        type: 'gguf' as const,
      };
    } finally {
      this._activeDownloads.delete(downloadKey);
    }
  }

  async deleteModel(id: string): Promise<void> {
    const model = await this.getModel(id);
    if (!model) throw new Error(`Model "${id}" not found`);

    if (model.type === 'mlx') {
      // MLX: remove the entire directory
      await fs.rm(model.filePath, { recursive: true });
      logger.info(`[ModelManager] Deleted MLX model directory: ${model.fileName}`);
      return;
    }

    // GGUF: Find and delete associated mmproj files from the same repo
    if (model.repo) {
      const entries = await fs.readdir(this.modelsDir);
      for (const entry of entries) {
        if (!entry.toLowerCase().includes('mmproj') || !entry.endsWith('.gguf')) continue;
        const meta = await this.readMeta(entry);
        if (meta?.repo === model.repo) {
          await fs.unlink(path.join(this.modelsDir, entry)).catch(() => {});
          await fs.unlink(this.metaPath(entry)).catch(() => {});
          logger.info(`[ModelManager] Deleted associated mmproj: ${entry}`);
        }
      }
    }

    await fs.unlink(model.filePath);
    try {
      await fs.unlink(this.metaPath(model.fileName));
    } catch {
      // meta file may not exist
    }
  }

  async downloadMlxModel(
    repo: string,
    onProgress?: (progress: DownloadProgress) => void,
  ): Promise<LocalModel> {
    const downloadKey = `mlx:${repo}`;
    if (this._activeDownloads.has(downloadKey)) {
      throw new Error(`Already downloading ${repo}`);
    }

    await this.ensureDir();

    // Derive directory name from repo (e.g., "mlx-community/Qwen3.5-9B-4bit" → "Qwen3.5-9B-4bit")
    const dirName = repo.split('/').pop()!;
    const modelDir = path.join(this.modelsDir, dirName);
    await fs.mkdir(modelDir, { recursive: true });

    // Write .downloading marker
    const markerPath = path.join(modelDir, '.downloading');
    await fs.writeFile(markerPath, '');

    // Write meta early
    const metaPath = path.join(modelDir, '.meta.json');
    await fs.writeFile(metaPath, JSON.stringify({ repo }, null, 2));

    const initialProgress: DownloadProgress = { fileName: dirName, downloadedBytes: 0, totalBytes: 0, percent: 0 };
    this._activeDownloads.set(downloadKey, { repo, fileName: dirName, progress: initialProgress });

    try {
      // Fetch file list from HuggingFace API
      const apiRes = await fetch(`https://huggingface.co/api/models/${repo}?blobs=true`);
      if (!apiRes.ok) throw new Error(`HuggingFace API error: ${apiRes.status}`);
      const detail: any = await apiRes.json();

      const siblings = (detail.siblings ?? []) as { rfilename: string; size?: number }[];
      const totalBytes = siblings.reduce((sum: number, s: any) => sum + (s.size ?? 0), 0);
      let downloadedBytes = 0;

      // Download each file
      for (const sibling of siblings) {
        const fileName = sibling.rfilename;
        const filePath = path.join(modelDir, fileName);

        // Create subdirectories if needed
        const fileDir = path.dirname(filePath);
        if (fileDir !== modelDir) {
          await fs.mkdir(fileDir, { recursive: true });
        }

        // Skip if already downloaded (resume)
        try {
          const existing = await fs.stat(filePath);
          if (existing.size === (sibling.size ?? 0)) {
            downloadedBytes += existing.size;
            const progress: DownloadProgress = {
              fileName: dirName,
              downloadedBytes,
              totalBytes,
              percent: totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0,
            };
            const entry = this._activeDownloads.get(downloadKey);
            if (entry) entry.progress = progress;
            onProgress?.(progress);
            continue;
          }
        } catch { /* file doesn't exist */ }

        const url = `https://huggingface.co/${repo}/resolve/main/${fileName}`;
        const response = await fetch(url, { redirect: 'follow' });
        if (!response.ok) throw new Error(`Download failed: ${response.status} ${response.statusText} for ${fileName}`);

        const body = response.body;
        if (!body) throw new Error(`No response body for ${fileName}`);

        const fileStream = createWriteStream(filePath);
        const activeDownloads = this._activeDownloads;

        const progressStream = new TransformStream({
          transform(chunk, controller) {
            downloadedBytes += chunk.byteLength;
            const progress: DownloadProgress = {
              fileName: dirName,
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
      }

      // Remove .downloading marker
      await fs.unlink(markerPath).catch(() => {});

      // Update meta
      const meta = { repo, downloadedAt: new Date().toISOString() };
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));

      const sizeBytes = await this.dirSize(modelDir);
      return {
        id: dirName,
        fileName: dirName,
        filePath: modelDir,
        sizeBytes,
        repo,
        downloadedAt: meta.downloadedAt,
        type: 'mlx',
      };
    } finally {
      this._activeDownloads.delete(downloadKey);
    }
  }

  async browseHuggingFace(query: string, limit = 10, format: 'gguf' | 'mlx' = 'gguf'): Promise<HuggingFaceModelResult[]> {
    // Strip HuggingFace URL prefixes so users can paste links directly
    let cleaned = query.replace(/^https?:\/\/huggingface\.co\//, '').replace(/\/$/, '');

    const searches: string[] = [];
    if (format === 'mlx') {
      // For MLX: search mlx-community first, then general
      if (!cleaned.includes('/')) {
        searches.push(`mlx-community/${cleaned}`);
      }
      searches.push(cleaned);
    } else {
      // GGUF: existing behavior
      searches.push(cleaned);
      if (/^[^/]+\/[^/]+$/.test(cleaned) && !cleaned.toLowerCase().includes('gguf')) {
        searches.push(cleaned.split('/')[1]!);
      }
    }

    const seen = new Set<string>();
    let models: any[] = [];
    for (const q of searches) {
      const filter = format === 'gguf' ? '&filter=gguf' : '';
      const url = `https://huggingface.co/api/models?search=${encodeURIComponent(q)}${filter}&sort=downloads&direction=-1&limit=${limit}`;
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

          if (format === 'mlx') {
            // For MLX: check for safetensors files, report total repo size as single entry
            const hasSafetensors = siblings.some((s: any) => s.rfilename?.endsWith('.safetensors'));
            if (hasSafetensors) {
              const totalSize = siblings.reduce((sum: number, s: any) => sum + (s.size ?? 0), 0);
              ggufFiles = [{ fileName: '__mlx_repo__', sizeBytes: totalSize }];
            }
          } else {
            ggufFiles = siblings
              .filter((s: any) => s.rfilename?.endsWith('.gguf'))
              .map((s: any) => ({
                fileName: s.rfilename,
                sizeBytes: s.size ?? 0,
              }));
          }
        }
      } catch {
        // Skip on error
      }

      // Merge tags from list and detail responses
      const listTags: string[] = Array.isArray(model.tags) ? model.tags : [];
      const allTags = [...new Set([...listTags, ...detailTags])];

      // For MLX format, skip repos without safetensors (no ggufFiles means no MLX content)
      if (format === 'mlx' && ggufFiles.length === 0) continue;

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

  private async readMlxMeta(dirName: string): Promise<{ repo?: string; downloadedAt?: string } | null> {
    try {
      const content = await fs.readFile(path.join(this.modelsDir, dirName, '.meta.json'), 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  private async dirSize(dirPath: string): Promise<number> {
    let total = 0;
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += await this.dirSize(entryPath);
      } else {
        const stat = await fs.stat(entryPath);
        total += stat.size;
      }
    }
    return total;
  }
}
