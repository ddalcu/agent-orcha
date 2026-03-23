import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ModelManager } from '../../lib/local-llm/model-manager.ts';

// ─── Helpers ────────────────────────────────────────────────────────────────

const WORKSPACE = '/tmp/test-workspace-mm';
const MODELS_DIR = path.join(WORKSPACE, '.models');

/** Clean up the real temp directory before/after each test */
async function cleanup() {
  await fs.rm(WORKSPACE, { recursive: true, force: true });
}

/** Create a GGUF file with optional meta */
async function createGgufFile(
  fileName: string,
  opts?: { sizeBytes?: number; repo?: string; downloadedAt?: string },
) {
  await fs.mkdir(MODELS_DIR, { recursive: true });
  const content = Buffer.alloc(opts?.sizeBytes ?? 100);
  await fs.writeFile(path.join(MODELS_DIR, fileName), content);
  if (opts?.repo || opts?.downloadedAt) {
    const meta: Record<string, string> = {};
    if (opts.repo) meta.repo = opts.repo;
    if (opts.downloadedAt) meta.downloadedAt = opts.downloadedAt;
    await fs.writeFile(
      path.join(MODELS_DIR, `${fileName}.meta.json`),
      JSON.stringify(meta, null, 2),
    );
  }
}

/** Create a directory-based model with .meta.json */
async function createDirModel(
  dirName: string,
  opts?: { repo?: string; downloadedAt?: string; downloading?: boolean; fileContents?: Record<string, string> },
) {
  const dirPath = path.join(MODELS_DIR, dirName);
  await fs.mkdir(dirPath, { recursive: true });
  const meta: Record<string, string> = {};
  if (opts?.repo) meta.repo = opts.repo;
  if (opts?.downloadedAt) meta.downloadedAt = opts.downloadedAt;
  await fs.writeFile(path.join(dirPath, '.meta.json'), JSON.stringify(meta, null, 2));

  if (opts?.fileContents) {
    for (const [name, content] of Object.entries(opts.fileContents)) {
      await fs.writeFile(path.join(dirPath, name), content);
    }
  }

  if (opts?.downloading) {
    await fs.writeFile(path.join(dirPath, '.downloading'), '');
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('ModelManager', () => {
  let manager: ModelManager;

  beforeEach(async () => {
    await cleanup();
    manager = new ModelManager(WORKSPACE);
  });

  afterEach(async () => {
    await cleanup();
  });

  // ─── constructor ────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('sets modelsDir to workspaceRoot/.models', () => {
      // Verify indirectly by calling a method that uses modelsDir
      const mgr = new ModelManager('/some/path');
      // listModels will create the dir — we just verify it doesn't throw
      assert.ok(mgr);
    });
  });

  // ─── getActiveDownloads ─────────────────────────────────────────────────

  describe('getActiveDownloads', () => {
    it('returns empty array when no downloads are active', () => {
      const result = manager.getActiveDownloads();
      assert.deepEqual(result, []);
    });
  });

  // ─── listModels ─────────────────────────────────────────────────────────

  describe('listModels', () => {
    it('returns empty array when no models exist', async () => {
      const models = await manager.listModels();
      assert.deepEqual(models, []);
    });

    it('lists GGUF model files', async () => {
      await createGgufFile('test-model.gguf', {
        repo: 'user/test-model',
        downloadedAt: '2024-01-01T00:00:00.000Z',
      });

      const models = await manager.listModels();
      assert.equal(models.length, 1);
      assert.equal(models[0].id, 'test-model');
      assert.equal(models[0].fileName, 'test-model.gguf');
      assert.equal(models[0].repo, 'user/test-model');
      assert.equal(models[0].downloadedAt, '2024-01-01T00:00:00.000Z');
      assert.equal(models[0].sizeBytes, 100);
    });

    it('skips mmproj GGUF files', async () => {
      await createGgufFile('test-model.gguf', { repo: 'user/repo' });
      await createGgufFile('test-model-mmproj-f16.gguf', { repo: 'user/repo' });

      const models = await manager.listModels();
      assert.equal(models.length, 1);
      assert.equal(models[0].fileName, 'test-model.gguf');
    });

    it('lists directory-based models', async () => {
      await createDirModel('Qwen-4bit', {
        repo: 'mlx-community/Qwen-4bit',
        downloadedAt: '2024-06-01T00:00:00.000Z',
        fileContents: { 'weights.safetensors': 'data' },
      });

      const models = await manager.listModels();
      assert.equal(models.length, 1);
      assert.equal(models[0].id, 'Qwen-4bit');
      assert.equal(models[0].repo, 'mlx-community/Qwen-4bit');
    });

    it('skips directory models with .downloading marker', async () => {
      await createDirModel('incomplete-model', { downloading: true });

      const models = await manager.listModels();
      assert.equal(models.length, 0);
    });

    it('skips directories without .meta.json', async () => {
      // Create a plain directory with no .meta.json
      await fs.mkdir(path.join(MODELS_DIR, 'random-dir'), { recursive: true });
      await fs.writeFile(path.join(MODELS_DIR, 'random-dir', 'somefile.txt'), 'data');

      const models = await manager.listModels();
      assert.equal(models.length, 0);
    });

    it('uses birthtime as downloadedAt when meta has no downloadedAt', async () => {
      await createGgufFile('no-date.gguf');

      const models = await manager.listModels();
      assert.equal(models.length, 1);
      // Should have a valid ISO date from birthtime
      assert.ok(models[0].downloadedAt);
      assert.ok(!isNaN(Date.parse(models[0].downloadedAt)));
    });

    it('lists both GGUF and directory-based models together', async () => {
      await createGgufFile('model-a.gguf', { repo: 'user/a' });
      await createDirModel('model-b', { repo: 'user/b' });

      const models = await manager.listModels();
      assert.equal(models.length, 2);
      const ids = models.map(m => m.id).sort();
      assert.deepEqual(ids, ['model-a', 'model-b']);
    });

    it('skips non-gguf files', async () => {
      await fs.mkdir(MODELS_DIR, { recursive: true });
      await fs.writeFile(path.join(MODELS_DIR, 'readme.txt'), 'hello');

      const models = await manager.listModels();
      assert.equal(models.length, 0);
    });
  });

  // ─── getModel ───────────────────────────────────────────────────────────

  describe('getModel', () => {
    it('returns the model matching the given id', async () => {
      await createGgufFile('my-model.gguf', { repo: 'user/my-model' });

      const model = await manager.getModel('my-model');
      assert.ok(model);
      assert.equal(model.id, 'my-model');
    });

    it('returns null when model is not found', async () => {
      const model = await manager.getModel('nonexistent');
      assert.equal(model, null);
    });
  });

  // ─── findModelFile ──────────────────────────────────────────────────────

  describe('findModelFile', () => {
    it('finds model by id', async () => {
      await createGgufFile('some-model.gguf');

      const result = await manager.findModelFile('some-model');
      assert.ok(result);
      assert.ok(result.filePath.endsWith('some-model.gguf'));
    });

    it('finds model by fileName', async () => {
      await createGgufFile('some-model.gguf');

      const result = await manager.findModelFile('some-model.gguf');
      assert.ok(result);
      assert.ok(result.filePath.endsWith('some-model.gguf'));
    });

    it('finds directory-based model by id', async () => {
      await createDirModel('dir-model');

      const result = await manager.findModelFile('dir-model');
      assert.ok(result);
      assert.ok(result.filePath.endsWith('dir-model'));
    });

    it('returns null when model is not found', async () => {
      const result = await manager.findModelFile('nope');
      assert.equal(result, null);
    });
  });

  // ─── findMmprojForModel ─────────────────────────────────────────────────

  describe('findMmprojForModel', () => {
    it('returns mmproj path when one exists for the same repo', async () => {
      await createGgufFile('model.gguf', { repo: 'user/vision-model' });
      await createGgufFile('model-mmproj-f16.gguf', { repo: 'user/vision-model' });

      const result = await manager.findMmprojForModel('model.gguf');
      assert.ok(result);
      assert.ok(result.includes('mmproj'));
    });

    it('returns null when no mmproj exists', async () => {
      await createGgufFile('model.gguf', { repo: 'user/text-model' });

      const result = await manager.findMmprojForModel('model.gguf');
      assert.equal(result, null);
    });

    it('returns null when model has no meta', async () => {
      await createGgufFile('model.gguf');

      const result = await manager.findMmprojForModel('model.gguf');
      assert.equal(result, null);
    });

    it('returns null when mmproj exists but from a different repo', async () => {
      await createGgufFile('model.gguf', { repo: 'user/model-a' });
      await createGgufFile('other-mmproj-f16.gguf', { repo: 'user/model-b' });

      const result = await manager.findMmprojForModel('model.gguf');
      assert.equal(result, null);
    });
  });

  // ─── deleteModel ────────────────────────────────────────────────────────

  describe('deleteModel', () => {
    it('deletes a GGUF model and its meta file', async () => {
      await createGgufFile('to-delete.gguf', { repo: 'user/repo' });

      await manager.deleteModel('to-delete');

      const files = await fs.readdir(MODELS_DIR);
      assert.ok(!files.includes('to-delete.gguf'));
      assert.ok(!files.includes('to-delete.gguf.meta.json'));
    });

    it('deletes associated mmproj files for the same repo', async () => {
      await createGgufFile('main-model.gguf', { repo: 'user/vision' });
      await createGgufFile('main-model-mmproj-f16.gguf', { repo: 'user/vision' });

      await manager.deleteModel('main-model');

      const files = await fs.readdir(MODELS_DIR);
      assert.ok(!files.includes('main-model.gguf'));
      assert.ok(!files.includes('main-model-mmproj-f16.gguf'));
    });

    it('does not delete mmproj files from different repos', async () => {
      await createGgufFile('model-a.gguf', { repo: 'user/repo-a' });
      await createGgufFile('other-mmproj-f16.gguf', { repo: 'user/repo-b' });

      await manager.deleteModel('model-a');

      const files = await fs.readdir(MODELS_DIR);
      assert.ok(files.includes('other-mmproj-f16.gguf'));
    });

    it('deletes directory-based model', async () => {
      await createDirModel('dir-to-delete', { repo: 'user/model' });

      await manager.deleteModel('dir-to-delete');

      const files = await fs.readdir(MODELS_DIR);
      assert.ok(!files.includes('dir-to-delete'));
    });

    it('throws when model is not found', async () => {
      await assert.rejects(
        () => manager.deleteModel('nonexistent'),
        { message: 'Model "nonexistent" not found' },
      );
    });

    it('handles deletion of model without repo (no mmproj cleanup)', async () => {
      await createGgufFile('no-repo.gguf');

      await manager.deleteModel('no-repo');

      const files = await fs.readdir(MODELS_DIR);
      assert.ok(!files.includes('no-repo.gguf'));
    });

    it('handles missing meta file gracefully on delete', async () => {
      await createGgufFile('no-meta.gguf');
      // Ensure no meta file exists
      await fs.unlink(path.join(MODELS_DIR, 'no-meta.gguf.meta.json')).catch(() => {});

      // Should not throw even without meta
      await manager.deleteModel('no-meta');

      const files = await fs.readdir(MODELS_DIR);
      assert.ok(!files.includes('no-meta.gguf'));
    });
  });

  // ─── getState / saveState ───────────────────────────────────────────────

  describe('getState', () => {
    it('returns default state when no state file exists', async () => {
      const state = await manager.getState();
      assert.deepEqual(state, { lastActiveModel: null });
    });

    it('returns saved state', async () => {
      await fs.mkdir(MODELS_DIR, { recursive: true });
      await fs.writeFile(
        path.join(MODELS_DIR, 'state.json'),
        JSON.stringify({ lastActiveModel: 'my-model', port: 8080 }),
      );

      const state = await manager.getState();
      assert.equal(state.lastActiveModel, 'my-model');
      assert.equal(state.port, 8080);
    });
  });

  describe('saveState', () => {
    it('writes state to state.json', async () => {
      await manager.saveState({ lastActiveModel: 'saved-model', port: 9000 });

      const content = await fs.readFile(path.join(MODELS_DIR, 'state.json'), 'utf-8');
      const state = JSON.parse(content);
      assert.equal(state.lastActiveModel, 'saved-model');
      assert.equal(state.port, 9000);
    });

    it('creates modelsDir if it does not exist', async () => {
      // MODELS_DIR does not exist yet
      await manager.saveState({ lastActiveModel: null });

      const stat = await fs.stat(MODELS_DIR);
      assert.ok(stat.isDirectory());
    });
  });

  // ─── getInterruptedDownloads ────────────────────────────────────────────

  describe('getInterruptedDownloads', () => {
    it('returns empty array when no interrupted downloads exist', async () => {
      const result = await manager.getInterruptedDownloads();
      assert.deepEqual(result, []);
    });

    it('detects interrupted GGUF downloads (.downloading file)', async () => {
      await fs.mkdir(MODELS_DIR, { recursive: true });
      await fs.writeFile(path.join(MODELS_DIR, 'model.gguf.downloading'), Buffer.alloc(5000));
      await fs.writeFile(
        path.join(MODELS_DIR, 'model.gguf.meta.json'),
        JSON.stringify({ repo: 'user/model' }),
      );

      const result = await manager.getInterruptedDownloads();
      assert.equal(result.length, 1);
      assert.equal(result[0].fileName, 'model.gguf');
      assert.equal(result[0].repo, 'user/model');
      assert.equal(result[0].downloadedBytes, 5000);
    });

    it('does not report directory models as interrupted', async () => {
      await createDirModel('dir-partial', {
        downloading: true,
        repo: 'user/partial',
        fileContents: { 'weights.safetensors': 'partial-data' },
      });

      const result = await manager.getInterruptedDownloads();
      assert.equal(result.length, 0);
    });

    it('skips files that are actively being downloaded', async () => {
      await fs.mkdir(MODELS_DIR, { recursive: true });
      await fs.writeFile(path.join(MODELS_DIR, 'active.gguf.downloading'), Buffer.alloc(100));

      // Simulate an active download by accessing the private map
      const activeDownloads = (manager as any)._activeDownloads as Map<string, any>;
      activeDownloads.set('user/active.gguf', {
        repo: 'user/repo',
        fileName: 'active.gguf',
        progress: { fileName: 'active.gguf', downloadedBytes: 50, totalBytes: 100, percent: 50 },
      });

      const result = await manager.getInterruptedDownloads();
      assert.equal(result.length, 0);

      activeDownloads.clear();
    });

    it('skips directory models in interrupted downloads check', async () => {
      await createDirModel('dir-active', { downloading: true });

      // Directory models are not detected by getInterruptedDownloads
      const result = await manager.getInterruptedDownloads();
      assert.equal(result.length, 0);
    });

    it('handles interrupted GGUF download without meta file', async () => {
      await fs.mkdir(MODELS_DIR, { recursive: true });
      await fs.writeFile(path.join(MODELS_DIR, 'no-meta.gguf.downloading'), Buffer.alloc(200));

      const result = await manager.getInterruptedDownloads();
      assert.equal(result.length, 1);
      assert.equal(result[0].fileName, 'no-meta.gguf');
      assert.equal(result[0].repo, undefined);
      assert.equal(result[0].downloadedBytes, 200);
    });
  });

  // ─── deleteInterruptedDownload ──────────────────────────────────────────

  describe('deleteInterruptedDownload', () => {
    it('deletes interrupted GGUF download files', async () => {
      await fs.mkdir(MODELS_DIR, { recursive: true });
      await fs.writeFile(path.join(MODELS_DIR, 'model.gguf.downloading'), Buffer.alloc(100));
      await fs.writeFile(
        path.join(MODELS_DIR, 'model.gguf.meta.json'),
        JSON.stringify({ repo: 'user/model' }),
      );

      await manager.deleteInterruptedDownload('model.gguf');

      const files = await fs.readdir(MODELS_DIR);
      assert.ok(!files.includes('model.gguf.downloading'));
      assert.ok(!files.includes('model.gguf.meta.json'));
    });

    it('handles non-existent interrupted download gracefully', async () => {
      await fs.mkdir(MODELS_DIR, { recursive: true });
      // Should not throw even if no matching .downloading file exists
      await manager.deleteInterruptedDownload('nonexistent.gguf');
    });

    it('handles missing download files gracefully', async () => {
      await fs.mkdir(MODELS_DIR, { recursive: true });
      // No files exist — should not throw
      await manager.deleteInterruptedDownload('nonexistent.gguf');
    });
  });

  // ─── downloadModel ─────────────────────────────────────────────────────

  describe('downloadModel', () => {
    it('throws if already downloading the same model', async () => {
      const activeDownloads = (manager as any)._activeDownloads as Map<string, any>;
      activeDownloads.set('user/repo/model.gguf', {
        repo: 'user/repo',
        fileName: 'model.gguf',
        progress: { fileName: 'model.gguf', downloadedBytes: 0, totalBytes: 0, percent: 0 },
      });

      await assert.rejects(
        () => manager.downloadModel('user/repo', 'model.gguf'),
        { message: 'Already downloading user/repo/model.gguf' },
      );

      activeDownloads.clear();
    });

    it('handles 416 status (range not satisfiable — file already complete)', async () => {
      await fs.mkdir(MODELS_DIR, { recursive: true });
      const content = Buffer.alloc(500);
      await fs.writeFile(path.join(MODELS_DIR, 'complete.gguf.downloading'), content);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock.fn(async () => ({
        status: 416,
        ok: false,
        headers: new Headers(),
      })) as any;

      try {
        const result = await manager.downloadModel('user/repo', 'complete.gguf');
        assert.equal(result.fileName, 'complete.gguf');
        assert.equal(result.repo, 'user/repo');
        assert.ok(result.downloadedAt);

        // Verify file was renamed from .downloading to final
        const files = await fs.readdir(MODELS_DIR);
        assert.ok(files.includes('complete.gguf'));
        assert.ok(!files.includes('complete.gguf.downloading'));
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('throws on non-ok, non-206, non-416 response', async () => {
      await fs.mkdir(MODELS_DIR, { recursive: true });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock.fn(async () => ({
        status: 404,
        ok: false,
        statusText: 'Not Found',
        headers: new Headers(),
      })) as any;

      try {
        await assert.rejects(
          () => manager.downloadModel('user/repo', 'missing.gguf'),
          { message: 'Download failed: 404 Not Found' },
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('throws when response has no body', async () => {
      await fs.mkdir(MODELS_DIR, { recursive: true });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock.fn(async () => ({
        status: 200,
        ok: true,
        headers: new Headers({ 'content-length': '100' }),
        body: null,
      })) as any;

      try {
        await assert.rejects(
          () => manager.downloadModel('user/repo', 'nobody.gguf'),
          { message: 'No response body' },
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('downloads a model successfully with progress tracking', async () => {
      await fs.mkdir(MODELS_DIR, { recursive: true });

      const testData = Buffer.from('hello-model-data');
      const originalFetch = globalThis.fetch;

      globalThis.fetch = mock.fn(async () => {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(testData));
            controller.close();
          },
        });
        return {
          status: 200,
          ok: true,
          headers: new Headers({ 'content-length': String(testData.length) }),
          body: stream,
        };
      }) as any;

      const progressUpdates: any[] = [];
      try {
        const result = await manager.downloadModel('user/repo', 'dl-test.gguf', (p) => {
          progressUpdates.push(p);
        });

        assert.equal(result.fileName, 'dl-test.gguf');
        assert.equal(result.id, 'dl-test');
        assert.equal(result.repo, 'user/repo');
        assert.ok(result.downloadedAt);

        // Verify the file exists
        const files = await fs.readdir(MODELS_DIR);
        assert.ok(files.includes('dl-test.gguf'));
        assert.ok(!files.includes('dl-test.gguf.downloading'));

        // Verify progress was reported
        assert.ok(progressUpdates.length > 0);
        const lastProgress = progressUpdates[progressUpdates.length - 1];
        assert.equal(lastProgress.fileName, 'dl-test.gguf');
        assert.equal(lastProgress.percent, 100);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('clears active download entry after completion', async () => {
      await fs.mkdir(MODELS_DIR, { recursive: true });

      const testData = Buffer.from('data');
      const originalFetch = globalThis.fetch;

      globalThis.fetch = mock.fn(async () => ({
        status: 200,
        ok: true,
        headers: new Headers({ 'content-length': String(testData.length) }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(testData));
            controller.close();
          },
        }),
      })) as any;

      try {
        await manager.downloadModel('user/repo', 'cleanup-test.gguf');
        assert.equal(manager.getActiveDownloads().length, 0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('clears active download entry on error', async () => {
      await fs.mkdir(MODELS_DIR, { recursive: true });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock.fn(async () => ({
        status: 500,
        ok: false,
        statusText: 'Server Error',
        headers: new Headers(),
      })) as any;

      try {
        await manager.downloadModel('user/repo', 'error-test.gguf').catch(() => {});
        assert.equal(manager.getActiveDownloads().length, 0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('resumes download with Range header when partial file exists', async () => {
      await fs.mkdir(MODELS_DIR, { recursive: true });
      // Create a partial download file
      await fs.writeFile(path.join(MODELS_DIR, 'resume.gguf.downloading'), Buffer.alloc(500));

      const originalFetch = globalThis.fetch;
      let capturedHeaders: Record<string, string> = {};

      globalThis.fetch = mock.fn(async (_url: string, opts: any) => {
        capturedHeaders = opts?.headers ?? {};
        const chunk = Buffer.from('more-data');
        return {
          status: 206,
          ok: false,
          headers: new Headers({ 'content-length': String(chunk.length) }),
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(chunk));
              controller.close();
            },
          }),
        };
      }) as any;

      try {
        const result = await manager.downloadModel('user/repo', 'resume.gguf');
        assert.equal(capturedHeaders['Range'], 'bytes=500-');
        assert.equal(result.fileName, 'resume.gguf');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('resets download when server returns 200 instead of 206 on resume attempt', async () => {
      await fs.mkdir(MODELS_DIR, { recursive: true });
      await fs.writeFile(path.join(MODELS_DIR, 'norng.gguf.downloading'), Buffer.alloc(100));

      const fullData = Buffer.from('complete-file-content');
      const originalFetch = globalThis.fetch;

      globalThis.fetch = mock.fn(async () => ({
        status: 200,
        ok: true,
        headers: new Headers({ 'content-length': String(fullData.length) }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(fullData));
            controller.close();
          },
        }),
      })) as any;

      const progressUpdates: any[] = [];
      try {
        const result = await manager.downloadModel('user/repo', 'norng.gguf', (p) => {
          progressUpdates.push(p);
        });
        assert.equal(result.fileName, 'norng.gguf');
        // When server returns 200 instead of 206, progress should start from 0
        if (progressUpdates.length > 0) {
          const first = progressUpdates[0];
          assert.equal(first.downloadedBytes, fullData.length); // starts from 0 + chunk
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('downloads file from subdirectory path and saves with basename only', async () => {
      await fs.mkdir(MODELS_DIR, { recursive: true });

      const testData = Buffer.from('wan-model-data');
      const originalFetch = globalThis.fetch;
      let requestedUrl = '';

      globalThis.fetch = mock.fn(async (url: string) => {
        requestedUrl = url;
        return {
          status: 200,
          ok: true,
          headers: new Headers({ 'content-length': String(testData.length) }),
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(testData));
              controller.close();
            },
          }),
        };
      }) as any;

      const progressUpdates: any[] = [];
      try {
        const result = await manager.downloadModel(
          'QuantStack/Wan2.2-T2V-A14B-GGUF',
          'LowNoise/Wan2.2-T2V-A14B-LowNoise-Q4_K_M.gguf',
          (p) => { progressUpdates.push(p); },
        );

        // URL should include the full subdirectory path
        assert.ok(
          requestedUrl.includes('LowNoise/Wan2.2-T2V-A14B-LowNoise-Q4_K_M.gguf'),
          `URL should contain subdir path, got: ${requestedUrl}`,
        );

        // Local file should use basename only (no subdirectory)
        assert.equal(result.fileName, 'Wan2.2-T2V-A14B-LowNoise-Q4_K_M.gguf');
        assert.equal(result.id, 'Wan2.2-T2V-A14B-LowNoise-Q4_K_M');
        assert.ok(result.filePath.endsWith('Wan2.2-T2V-A14B-LowNoise-Q4_K_M.gguf'));
        assert.ok(!result.filePath.includes('LowNoise/'));

        // Verify file exists with basename in the models dir
        const files = await fs.readdir(MODELS_DIR);
        assert.ok(files.includes('Wan2.2-T2V-A14B-LowNoise-Q4_K_M.gguf'));
        assert.ok(!files.includes('LowNoise')); // no subdirectory created

        // Meta file should also use basename
        assert.ok(files.includes('Wan2.2-T2V-A14B-LowNoise-Q4_K_M.gguf.meta.json'));

        // Progress should report basename
        assert.ok(progressUpdates.length > 0);
        assert.equal(progressUpdates[0].fileName, 'Wan2.2-T2V-A14B-LowNoise-Q4_K_M.gguf');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('downloads safetensors from subdirectory path correctly', async () => {
      await fs.mkdir(MODELS_DIR, { recursive: true });

      const testData = Buffer.from('vae-data');
      const originalFetch = globalThis.fetch;

      globalThis.fetch = mock.fn(async () => ({
        status: 200,
        ok: true,
        headers: new Headers({ 'content-length': String(testData.length) }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(testData));
            controller.close();
          },
        }),
      })) as any;

      try {
        const result = await manager.downloadModel(
          'QuantStack/Wan2.2-T2V-A14B-GGUF',
          'VAE/Wan2.1_VAE.safetensors',
        );

        assert.equal(result.fileName, 'Wan2.1_VAE.safetensors');
        assert.ok(!result.filePath.includes('VAE/'));

        const files = await fs.readdir(MODELS_DIR);
        assert.ok(files.includes('Wan2.1_VAE.safetensors'));
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('flat fileName (no subdirectory) still works unchanged', async () => {
      await fs.mkdir(MODELS_DIR, { recursive: true });

      const testData = Buffer.from('flat-file');
      const originalFetch = globalThis.fetch;

      globalThis.fetch = mock.fn(async () => ({
        status: 200,
        ok: true,
        headers: new Headers({ 'content-length': String(testData.length) }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(testData));
            controller.close();
          },
        }),
      })) as any;

      try {
        const result = await manager.downloadModel('user/repo', 'flat-model.gguf');

        assert.equal(result.fileName, 'flat-model.gguf');
        assert.equal(result.id, 'flat-model');

        const files = await fs.readdir(MODELS_DIR);
        assert.ok(files.includes('flat-model.gguf'));
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // ─── downloadDirectory ─────────────────────────────────────────────────

  describe('downloadDirectory', () => {
    it('throws if already downloading the same directory', async () => {
      const activeDownloads = (manager as any)._activeDownloads as Map<string, any>;
      activeDownloads.set('dir:user/model', {
        repo: 'user/model',
        fileName: 'model',
        progress: { fileName: 'model', downloadedBytes: 0, totalBytes: 0, percent: 0 },
      });

      await assert.rejects(
        () => manager.downloadDirectory('user/model'),
        { message: 'Already downloading dir:user/model' },
      );

      activeDownloads.clear();
    });

    it('throws on HuggingFace API error', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock.fn(async () => ({
        status: 500,
        ok: false,
      })) as any;

      try {
        await assert.rejects(
          () => manager.downloadDirectory('user/bad-model'),
          { message: 'HuggingFace API error: 500' },
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('downloads model files and removes .downloading marker', async () => {
      const originalFetch = globalThis.fetch;
      const fileData = Buffer.from('weight-data');

      let callCount = 0;
      globalThis.fetch = mock.fn(async (url: string) => {
        callCount++;
        // First call: API call
        if (callCount === 1) {
          return {
            status: 200,
            ok: true,
            json: async () => ({
              siblings: [
                { rfilename: 'config.json', size: 10 },
                { rfilename: 'weights.safetensors', size: fileData.length },
              ],
            }),
          };
        }
        // Subsequent calls: file downloads
        return {
          status: 200,
          ok: true,
          headers: new Headers({ 'content-length': String(fileData.length) }),
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(fileData));
              controller.close();
            },
          }),
        };
      }) as any;

      try {
        const result = await manager.downloadDirectory('user/TestModel-4bit');
        assert.equal(result.fileName, 'TestModel-4bit');
        assert.equal(result.id, 'TestModel-4bit');
        assert.equal(result.repo, 'user/TestModel-4bit');
        assert.ok(result.downloadedAt);

        // Verify .downloading marker was removed
        const modelDir = path.join(MODELS_DIR, 'TestModel-4bit');
        const files = await fs.readdir(modelDir);
        assert.ok(!files.includes('.downloading'));
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('clears active download on error', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock.fn(async () => ({
        status: 500,
        ok: false,
      })) as any;

      try {
        await manager.downloadDirectory('user/fail').catch(() => {});
        assert.equal(manager.getActiveDownloads().length, 0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('skips already downloaded files during resume', async () => {
      const originalFetch = globalThis.fetch;
      const fileData = Buffer.from('weight-data');

      // Pre-create the model directory with one already-complete file
      const modelDir = path.join(MODELS_DIR, 'ResumeModel');
      await fs.mkdir(modelDir, { recursive: true });
      await fs.writeFile(path.join(modelDir, 'config.json'), '{}');
      await fs.writeFile(path.join(modelDir, '.downloading'), '');
      await fs.writeFile(path.join(modelDir, '.meta.json'), JSON.stringify({ repo: 'user/ResumeModel' }));

      let downloadedFiles: string[] = [];
      let callCount = 0;
      globalThis.fetch = mock.fn(async (url: string) => {
        callCount++;
        if (callCount === 1) {
          return {
            status: 200,
            ok: true,
            json: async () => ({
              siblings: [
                { rfilename: 'config.json', size: 2 }, // Already exists with matching size
                { rfilename: 'weights.safetensors', size: fileData.length },
              ],
            }),
          };
        }
        downloadedFiles.push(url);
        return {
          status: 200,
          ok: true,
          headers: new Headers({ 'content-length': String(fileData.length) }),
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(fileData));
              controller.close();
            },
          }),
        };
      }) as any;

      try {
        await manager.downloadDirectory('user/ResumeModel', undefined, undefined, 'ResumeModel');
        // config.json is 2 bytes but the file on disk is also 2 bytes ('{}')
        // so it should skip config.json and only download weights.safetensors
        assert.equal(downloadedFiles.length, 1);
        assert.ok(downloadedFiles[0].includes('weights.safetensors'));
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('creates subdirectories for nested files', async () => {
      const originalFetch = globalThis.fetch;
      const fileData = Buffer.from('data');

      let callCount = 0;
      globalThis.fetch = mock.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            status: 200,
            ok: true,
            json: async () => ({
              siblings: [
                { rfilename: 'subdir/nested-file.bin', size: fileData.length },
              ],
            }),
          };
        }
        return {
          status: 200,
          ok: true,
          headers: new Headers({ 'content-length': String(fileData.length) }),
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(fileData));
              controller.close();
            },
          }),
        };
      }) as any;

      try {
        await manager.downloadDirectory('user/NestedModel');
        const nestedFile = path.join(MODELS_DIR, 'NestedModel', 'subdir', 'nested-file.bin');
        const stat = await fs.stat(nestedFile);
        assert.ok(stat.isFile());
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // ─── browseHuggingFace ──────────────────────────────────────────────────

  describe('browseHuggingFace', () => {
    it('searches HuggingFace API for GGUF models', async () => {
      const originalFetch = globalThis.fetch;
      let capturedUrls: string[] = [];

      globalThis.fetch = mock.fn(async (url: string) => {
        capturedUrls.push(url);
        if (url.includes('/api/models?search=')) {
          return {
            status: 200,
            ok: true,
            json: async () => [{
              modelId: 'user/test-gguf',
              author: 'user',
              likes: 10,
              downloads: 1000,
              tags: ['gguf'],
              pipeline_tag: 'text-generation',
            }],
          };
        }
        // Detail endpoint
        return {
          status: 200,
          ok: true,
          json: async () => ({
            pipeline_tag: 'text-generation',
            tags: ['gguf', 'llama'],
            siblings: [
              { rfilename: 'model-Q4.gguf', size: 4000000 },
              { rfilename: 'model-Q8.gguf', size: 8000000 },
            ],
          }),
        };
      }) as any;

      try {
        const results = await manager.browseHuggingFace('test', 5);
        assert.ok(results.length > 0);
        assert.equal(results[0].repoId, 'user/test-gguf');
        assert.equal(results[0].ggufFiles.length, 2);
        assert.ok(capturedUrls[0].includes('filter=gguf'));
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('strips HuggingFace URL prefix from query', async () => {
      const originalFetch = globalThis.fetch;
      let capturedUrls: string[] = [];

      globalThis.fetch = mock.fn(async (url: string) => {
        capturedUrls.push(url);
        if (url.includes('/api/models?search=')) {
          return { status: 200, ok: true, json: async () => [] };
        }
        return { status: 200, ok: true, json: async () => ({}) };
      }) as any;

      try {
        await manager.browseHuggingFace('https://huggingface.co/user/model', 5);
        // Should have searched for 'user/model', not the full URL
        assert.ok(capturedUrls[0].includes('search=user%2Fmodel'));
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('performs second search without GGUF suffix for repo-style queries', async () => {
      const originalFetch = globalThis.fetch;
      let searchUrls: string[] = [];

      globalThis.fetch = mock.fn(async (url: string) => {
        if (url.includes('/api/models?search=')) {
          searchUrls.push(url);
          return { status: 200, ok: true, json: async () => [] };
        }
        return { status: 200, ok: true, json: async () => ({}) };
      }) as any;

      try {
        // Query that looks like owner/repo without 'gguf' → triggers extra search
        await manager.browseHuggingFace('TheBloke/model', 5);
        // Should have done two searches: 'TheBloke/model' and 'model'
        assert.equal(searchUrls.length, 2);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('deduplicates results across searches', async () => {
      const originalFetch = globalThis.fetch;

      globalThis.fetch = mock.fn(async (url: string) => {
        if (url.includes('/api/models?search=')) {
          return {
            status: 200,
            ok: true,
            json: async () => [{
              modelId: 'user/same-model',
              author: 'user',
              likes: 1,
              downloads: 100,
              tags: ['gguf'],
            }],
          };
        }
        return {
          status: 200,
          ok: true,
          json: async () => ({
            siblings: [{ rfilename: 'model.gguf', size: 1000 }],
          }),
        };
      }) as any;

      try {
        const results = await manager.browseHuggingFace('user/same-model', 5);
        // Even though both searches return the same model, it should only appear once
        assert.equal(results.length, 1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('throws on HuggingFace API error', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock.fn(async () => ({
        status: 503,
        ok: false,
      })) as any;

      try {
        await assert.rejects(
          () => manager.browseHuggingFace('test'),
          { message: 'HuggingFace API error: 503' },
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('handles detail API failure gracefully', async () => {
      const originalFetch = globalThis.fetch;

      globalThis.fetch = mock.fn(async (url: string) => {
        if (url.includes('/api/models?search=')) {
          return {
            status: 200,
            ok: true,
            json: async () => [{
              modelId: 'user/model',
              author: 'user',
              likes: 1,
              downloads: 100,
              tags: ['gguf'],
            }],
          };
        }
        // Detail API fails
        throw new Error('Network error');
      }) as any;

      try {
        const results = await manager.browseHuggingFace('test', 5);
        // Should still return result, just without ggufFiles
        assert.equal(results.length, 1);
        assert.equal(results[0].ggufFiles.length, 0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('limits results to the specified count', async () => {
      const originalFetch = globalThis.fetch;

      globalThis.fetch = mock.fn(async (url: string) => {
        if (url.includes('/api/models?search=')) {
          const models = [];
          for (let i = 0; i < 20; i++) {
            models.push({
              modelId: `user/model-${i}`,
              author: 'user',
              downloads: 20 - i,
              tags: ['gguf'],
            });
          }
          return { status: 200, ok: true, json: async () => models };
        }
        return {
          status: 200,
          ok: true,
          json: async () => ({
            siblings: [{ rfilename: 'model.gguf', size: 1000 }],
          }),
        };
      }) as any;

      try {
        const results = await manager.browseHuggingFace('test', 3);
        assert.equal(results.length, 3);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // ─── autoDownloadMmproj ────────────────────────────────────────────────

  describe('autoDownloadMmproj', () => {
    it('returns null when mmproj already exists for the repo', async () => {
      await createGgufFile('existing-mmproj-f16.gguf', { repo: 'user/vision-model' });

      const result = await manager.autoDownloadMmproj('user/vision-model');
      assert.equal(result, null);
    });

    it('returns null when HuggingFace API fails', async () => {
      await fs.mkdir(MODELS_DIR, { recursive: true });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock.fn(async () => ({
        status: 500,
        ok: false,
      })) as any;

      try {
        const result = await manager.autoDownloadMmproj('user/model');
        assert.equal(result, null);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('returns null when repo has no mmproj files', async () => {
      await fs.mkdir(MODELS_DIR, { recursive: true });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock.fn(async (url: string) => {
        if (url.includes('/api/models/')) {
          return {
            status: 200,
            ok: true,
            json: async () => ({
              siblings: [
                { rfilename: 'model-Q4.gguf', size: 4000 },
              ],
            }),
          };
        }
        // Should not reach downloadModel since there are no mmproj files
        throw new Error('Should not download');
      }) as any;

      try {
        const result = await manager.autoDownloadMmproj('user/no-mmproj');
        assert.equal(result, null);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('prefers f16/bf16 mmproj variant', async () => {
      await fs.mkdir(MODELS_DIR, { recursive: true });

      const originalFetch = globalThis.fetch;
      let downloadedFileName = '';
      let callCount = 0;

      globalThis.fetch = mock.fn(async (url: string) => {
        callCount++;
        // First call: API listing
        if (callCount === 1) {
          return {
            status: 200,
            ok: true,
            json: async () => ({
              siblings: [
                { rfilename: 'model.gguf', size: 4000 },
                { rfilename: 'model-mmproj-f32.gguf', size: 2000 },
                { rfilename: 'model-mmproj-f16.gguf', size: 1000 },
              ],
            }),
          };
        }
        // Second call: the actual download of the mmproj
        downloadedFileName = url.split('/').pop()!;
        const data = Buffer.from('mmproj-data');
        return {
          status: 200,
          ok: true,
          headers: new Headers({ 'content-length': String(data.length) }),
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(data));
              controller.close();
            },
          }),
        };
      }) as any;

      try {
        const result = await manager.autoDownloadMmproj('user/vision-model');
        assert.ok(result);
        assert.equal(downloadedFileName, 'model-mmproj-f16.gguf');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('returns null on fetch error', async () => {
      await fs.mkdir(MODELS_DIR, { recursive: true });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock.fn(async () => {
        throw new Error('Network failure');
      }) as any;

      try {
        const result = await manager.autoDownloadMmproj('user/model');
        assert.equal(result, null);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
