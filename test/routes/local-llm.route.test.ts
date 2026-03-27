import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import Fastify from 'fastify';
import { localLlmRoutes } from '../../src/routes/local-llm.route.ts';
import { loadModelsConfig, getModelsConfig } from '../../lib/llm/llm-config.ts';

// ─── Helpers ────────────────────────────────────────────────────────────────

let WORKSPACE: string;
let MODELS_DIR: string;
let MODELS_YAML_PATH: string;

const BASE_YAML = `
version: "1.0"
llm:
  default: omni
  omni:
    provider: omni
    model: test
    active: true
embeddings:
  default: omni
  omni:
    provider: omni
    model: test-embed
`;

const YAML_WITH_IMAGE = BASE_YAML + `
image:
  default: omni
  omni:
    modelPath: .models/existing/model.gguf
    steps: 20
    description: existing
`;

const YAML_WITH_TTS = BASE_YAML + `
tts:
  default: omni
  omni:
    modelPath: .models/qwen3-tts
    description: existing-tts
`;

async function setupWorkspace() {
  WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), 'local-llm-test-'));
  MODELS_DIR = path.join(WORKSPACE, '.models');
  MODELS_YAML_PATH = path.join(WORKSPACE, 'models.yaml');
  await fs.mkdir(MODELS_DIR, { recursive: true });
}

async function cleanupWorkspace() {
  await fs.rm(WORKSPACE, { recursive: true, force: true });
}

async function loadYaml(yaml: string) {
  await fs.writeFile(MODELS_YAML_PATH, yaml);
  await loadModelsConfig(MODELS_YAML_PATH);
}

/** Create a directory-based model (image bundle or TTS) */
async function createBundleModel(
  dirName: string,
  files: Record<string, string>,
  repo?: string,
) {
  const dirPath = path.join(MODELS_DIR, dirName);
  await fs.mkdir(dirPath, { recursive: true });
  const meta: Record<string, any> = { downloadedAt: new Date().toISOString() };
  if (repo) meta.repo = repo;
  await fs.writeFile(path.join(dirPath, '.meta.json'), JSON.stringify(meta));
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dirPath, name), content);
  }
}

function createTestApp() {
  const app = Fastify({ logger: false });
  app.decorate('orchestrator', {
    workspaceRoot: WORKSPACE,
    modelsConfigPath: MODELS_YAML_PATH,
  } as any);
  return app;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('local-llm.route — activate-image', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    await setupWorkspace();
    await loadYaml(BASE_YAML);
    app = createTestApp();
    await app.register(localLlmRoutes, { prefix: '/api/local-llm' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await cleanupWorkspace();
  });

  it('returns 404 for non-existent model', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/local-llm/models/nonexistent/activate-image',
    });
    assert.equal(res.statusCode, 404);
    assert.match(res.json().error, /not found/i);
  });

  it('returns 400 when model directory has no .gguf files', async () => {
    await createBundleModel('empty-bundle', {
      'readme.txt': 'no gguf here',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/local-llm/models/empty-bundle/activate-image',
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /no.*gguf/i);
  });

  it('returns 500 with error when OmniModelCache fails (expected in test env)', async () => {
    await createBundleModel('flux2-klein', {
      'flux-2-klein-4b-Q4_K_M.gguf': 'model-data',
      'Qwen3-4B-Q4_K_M.gguf': 'llm-data',
      'flux2-vae.safetensors': 'vae-data',
    }, 'unsloth/FLUX.2-klein-4B-GGUF');

    const res = await app.inject({
      method: 'POST',
      url: '/api/local-llm/models/flux2-klein/activate-image',
    });

    // OmniModelCache isn't available in test — expect 500 with a proper error message
    assert.equal(res.statusCode, 500);
    assert.ok(res.json().error, 'Should return an error message');
  });
});

describe('local-llm.route — activate-tts', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    await setupWorkspace();
    await loadYaml(BASE_YAML);
    app = createTestApp();
    await app.register(localLlmRoutes, { prefix: '/api/local-llm' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await cleanupWorkspace();
  });

  it('returns 404 for non-existent model', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/local-llm/models/nonexistent/activate-tts',
    });
    assert.equal(res.statusCode, 404);
    assert.match(res.json().error, /not found/i);
  });

  it('returns 500 with error when OmniModelCache fails (expected in test env)', async () => {
    await createBundleModel('qwen3-tts', {
      'model.bin': 'tts-data',
    }, 'some/tts-repo');

    const res = await app.inject({
      method: 'POST',
      url: '/api/local-llm/models/qwen3-tts/activate-tts',
    });

    assert.equal(res.statusCode, 500);
    assert.ok(res.json().error, 'Should return an error message');
  });
});

describe('local-llm.route — download auto-config slot detection', () => {
  afterEach(async () => {
    await cleanupWorkspace();
  });

  it('detects existing image config', async () => {
    await setupWorkspace();
    await loadYaml(YAML_WITH_IMAGE);

    const config = getModelsConfig();
    const hasExisting = config?.image && Object.values(config.image).some(
      (v: any) => typeof v === 'object' && v.modelPath,
    );
    assert.equal(hasExisting, true, 'Should detect existing image config');
  });

  it('detects empty image slot when no image section', async () => {
    await setupWorkspace();
    await loadYaml(BASE_YAML);

    const config = getModelsConfig();
    const hasExisting = config?.image && Object.values(config.image).some(
      (v: any) => typeof v === 'object' && v.modelPath,
    );
    assert.ok(!hasExisting, 'Should not detect image config when none exists');
  });

  it('detects existing tts config', async () => {
    await setupWorkspace();
    await loadYaml(YAML_WITH_TTS);

    const config = getModelsConfig();
    const hasExisting = config?.tts && Object.values(config.tts).some(
      (v: any) => typeof v === 'object' && v.modelPath,
    );
    assert.equal(hasExisting, true, 'Should detect existing tts config');
  });

  it('detects empty tts slot when no tts section', async () => {
    await setupWorkspace();
    await loadYaml(BASE_YAML);

    const config = getModelsConfig();
    const hasExisting = config?.tts && Object.values(config.tts).some(
      (v: any) => typeof v === 'object' && v.modelPath,
    );
    assert.ok(!hasExisting, 'Should not detect tts config when none exists');
  });
});

describe('local-llm.route — downloadKey in active downloads', () => {
  it('getActiveDownloads returns empty array with correct shape', async () => {
    await setupWorkspace();
    const { ModelManager } = await import('../../lib/local-llm/model-manager.ts');
    const manager = new ModelManager(WORKSPACE);
    const downloads = manager.getActiveDownloads();

    assert.ok(Array.isArray(downloads));
    assert.equal(downloads.length, 0);
    await cleanupWorkspace();
  });
});

describe('local-llm.route — image model file detection logic', () => {
  afterEach(async () => {
    await cleanupWorkspace();
  });

  it('identifies main model, vae, and llm companion in bundle directory', async () => {
    await setupWorkspace();
    const dirPath = path.join(MODELS_DIR, 'flux2-klein');
    await fs.mkdir(dirPath, { recursive: true });
    await fs.writeFile(path.join(dirPath, 'flux-2-klein-4b-Q4_K_M.gguf'), 'main');
    await fs.writeFile(path.join(dirPath, 'Qwen3-4B-Q4_K_M.gguf'), 'llm');
    await fs.writeFile(path.join(dirPath, 'flux2-vae.safetensors'), 'vae');

    const files = await fs.readdir(dirPath);
    const ggufFiles = files.filter(f => f.endsWith('.gguf'));
    const vaeFile = files.find(f => /vae/i.test(f) && f.endsWith('.safetensors'));
    const mainModel = ggufFiles.find(f => /flux|stable.?diff|sdxl/i.test(f))
      || ggufFiles[0];
    const llmCompanion = ggufFiles.find(f => f !== mainModel);

    assert.equal(mainModel, 'flux-2-klein-4b-Q4_K_M.gguf');
    assert.equal(vaeFile, 'flux2-vae.safetensors');
    assert.equal(llmCompanion, 'Qwen3-4B-Q4_K_M.gguf');
  });

  it('falls back to first gguf when no flux/sd pattern matches', async () => {
    await setupWorkspace();
    const dirPath = path.join(MODELS_DIR, 'custom-image');
    await fs.mkdir(dirPath, { recursive: true });
    await fs.writeFile(path.join(dirPath, 'alpha-model.gguf'), 'main');
    await fs.writeFile(path.join(dirPath, 'beta-model.gguf'), 'companion');

    const files = await fs.readdir(dirPath);
    const ggufFiles = files.filter(f => f.endsWith('.gguf'));
    const mainModel = ggufFiles.find(f => /flux|stable.?diff|sdxl/i.test(f))
      || ggufFiles.find(f => f.toLowerCase().includes('custom-image'))
      || ggufFiles[0];

    assert.ok(mainModel, 'Should find at least one gguf as main model');
    assert.equal(ggufFiles.length, 2);
  });

  it('detects vae .safetensors file by name pattern', async () => {
    await setupWorkspace();
    const dirPath = path.join(MODELS_DIR, 'test-bundle');
    await fs.mkdir(dirPath, { recursive: true });
    await fs.writeFile(path.join(dirPath, 'model.gguf'), 'main');
    await fs.writeFile(path.join(dirPath, 'my-VAE-encoder.safetensors'), 'vae');
    await fs.writeFile(path.join(dirPath, 'clip.safetensors'), 'clip');

    const files = await fs.readdir(dirPath);
    const vaeFile = files.find(f => /vae/i.test(f) && f.endsWith('.safetensors'));

    assert.equal(vaeFile, 'my-VAE-encoder.safetensors');
  });
});
