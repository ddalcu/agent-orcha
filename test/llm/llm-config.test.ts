import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { fileURLToPath } from 'url';
import {
  loadModelsConfig,
  getModelConfig,
  getEmbeddingConfig,
  listModelConfigs,
  listEmbeddingConfigs,
  listImageConfigs,
  listTtsConfigs,
  isModelsConfigLoaded,
  resolveApiKey,
} from '../../lib/llm/llm-config.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, '..', 'fixtures', 'models.yaml');

describe('loadModelsConfig', () => {
  it('should load and validate config from fixture', async () => {
    const config = await loadModelsConfig(fixturePath);

    assert.ok(config);
    assert.equal(config.version, '1.0');
    assert.ok(config.llm['default']);
    assert.ok(config.embeddings['default']);
  });

  it('should load YAML config with share flags', async () => {
    const config = await loadModelsConfig(fixturePath);

    const sharedModel = config.llm['shared-model'];
    assert.ok(sharedModel);
    assert.ok(typeof sharedModel !== 'string');
    assert.equal(sharedModel.share, true);
    assert.equal(sharedModel.model, 'gpt-4o');
  });

  it('should list image configs with share flag', async () => {
    const config = await loadModelsConfig(fixturePath);

    const imageConfigs = listImageConfigs();
    assert.ok(imageConfigs.length > 0);
    const imageGen = imageConfigs.find(c => c.name === 'image-gen');
    assert.ok(imageGen);
    assert.equal(imageGen.config.share, true);
    assert.equal(imageGen.config.description, 'FLUX.2 image generation');
  });

  it('should list tts configs with share flag', async () => {
    const config = await loadModelsConfig(fixturePath);

    const ttsConfigs = listTtsConfigs();
    assert.ok(ttsConfigs.length > 0);
    const tts = ttsConfigs.find(c => c.name === 'tts');
    assert.ok(tts);
    assert.equal(tts.config.share, true);
    assert.equal(tts.config.description, 'Qwen3 TTS');
  });
});

describe('getModelConfig', () => {
  before(async () => {
    await loadModelsConfig(fixturePath);
  });

  it('should return config for known model', () => {
    const config = getModelConfig('default');
    assert.equal(config.model, 'gpt-4o-mini');
    assert.equal(config.provider, 'openai');
  });

  it('should return fast model config', () => {
    const config = getModelConfig('fast');
    assert.equal(config.model, 'gpt-3.5-turbo');
    assert.equal(config.temperature, 0.1);
  });

  it('should throw for unknown model', () => {
    assert.throws(
      () => getModelConfig('nonexistent'),
      /not found/
    );
  });
});

describe('getEmbeddingConfig', () => {
  before(async () => {
    await loadModelsConfig(fixturePath);
  });

  it('should return config for known embedding', () => {
    const config = getEmbeddingConfig('default');
    assert.equal(config.model, 'text-embedding-3-small');
  });

  it('should throw for unknown embedding', () => {
    assert.throws(
      () => getEmbeddingConfig('nonexistent'),
      /not found/
    );
  });
});

describe('listModelConfigs', () => {
  it('should list concrete model names (not pointers)', () => {
    const names = listModelConfigs();
    // 'default' is a string pointer, so it should NOT be in the list
    assert.ok(!names.includes('default'));
    assert.ok(names.includes('fast'));
    assert.ok(names.includes('openai'));
    assert.ok(names.includes('shared-model'));
  });
});

describe('listEmbeddingConfigs', () => {
  it('should list concrete embedding names (not pointers)', () => {
    const names = listEmbeddingConfigs();
    // 'default' is a string pointer, so it should NOT be in the list
    assert.ok(!names.includes('default'));
    assert.ok(names.includes('openai'));
  });
});

describe('isModelsConfigLoaded', () => {
  it('should return true after loading config', async () => {
    await loadModelsConfig(fixturePath);
    assert.equal(isModelsConfigLoaded(), true);
  });
});

describe('loadModelsConfig with null apiKey (YAML null from empty env var)', () => {
  it('should parse without error when apiKey is YAML null', async () => {
    // YAML null occurs when an env var is set to empty string and substituted into the config
    const yaml = `
version: "1.0"
llm:
  default: local
  local:
    provider: local
    model: llama3
    apiKey: null
embeddings:
  default: local
  local:
    provider: local
    model: nomic-embed
    apiKey: null
`;
    const tmpFile = path.join(os.tmpdir(), `models-null-apikey-${Date.now()}.yaml`);
    await fs.writeFile(tmpFile, yaml);
    try {
      const config = await loadModelsConfig(tmpFile);
      const localLlm = config.llm['local'];
      assert.ok(localLlm && typeof localLlm !== 'string');
      // null should be coerced to undefined — not propagated as null
      assert.equal((localLlm as any).apiKey, undefined);
      const localEmb = config.embeddings['local'];
      assert.ok(localEmb && typeof localEmb !== 'string');
      assert.equal((localEmb as any).apiKey, undefined);
    } finally {
      await fs.unlink(tmpFile).catch(() => { /* temp file may already be removed */ });
    }
  });

  it('resolveApiKey should handle undefined apiKey from null-coerced config', () => {
    // When apiKey was null in YAML and got coerced to undefined, resolveApiKey must not crash
    process.env.OPENAI_API_KEY = '';
    const result = resolveApiKey('openai', undefined);
    // Empty env var → falls back to the (empty) env value or undefined; either is acceptable
    assert.ok(result === undefined || typeof result === 'string');
    delete process.env.OPENAI_API_KEY;
  });
});

describe('resolveApiKey', () => {
  const saved: Record<string, string | undefined> = {};

  before(() => {
    saved.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    saved.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    saved.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  });

  after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('should return explicit apiKey when provided', () => {
    assert.equal(resolveApiKey('openai', 'my-key'), 'my-key');
  });

  it('should fall back to env var', () => {
    process.env.OPENAI_API_KEY = 'env-key';
    assert.equal(resolveApiKey('openai'), 'env-key');
  });

  it('should return undefined when no key available', () => {
    delete process.env.ANTHROPIC_API_KEY;
    assert.equal(resolveApiKey('anthropic'), undefined);
  });

  it('should resolve ${OPENROUTER_API_KEY} when env var is set', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-test123';
    assert.equal(resolveApiKey('openrouter', '${OPENROUTER_API_KEY}'), 'sk-or-v1-test123');
  });

  it('should return undefined for unresolved ${OPENROUTER_API_KEY} placeholder', () => {
    delete process.env.OPENROUTER_API_KEY;
    assert.equal(resolveApiKey('openrouter', '${OPENROUTER_API_KEY}'), undefined);
  });

  it('should fall back to OPENROUTER_API_KEY env var when no explicit key', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-fallback';
    assert.equal(resolveApiKey('openrouter'), 'sk-or-v1-fallback');
  });

  it('should return undefined for openrouter when env var not set and no explicit key', () => {
    delete process.env.OPENROUTER_API_KEY;
    assert.equal(resolveApiKey('openrouter'), undefined);
  });

  it('should return explicit key for openrouter even when env var differs', () => {
    process.env.OPENROUTER_API_KEY = 'env-key';
    assert.equal(resolveApiKey('openrouter', 'explicit-key'), 'explicit-key');
  });

  it('should return undefined when apiKey is unresolved placeholder for any provider', () => {
    delete process.env.OPENAI_API_KEY;
    assert.equal(resolveApiKey('openai', '${OPENAI_API_KEY}'), undefined);
  });
});

describe('getModelConfig — openrouter', () => {
  before(async () => {
    await loadModelsConfig(fixturePath);
  });

  it('should return openrouter config with explicit provider', () => {
    const config = getModelConfig('openrouter');
    assert.equal(config.provider, 'openrouter');
    assert.equal(config.model, 'deepseek/deepseek-r1');
    assert.equal(config.apiKey, 'test-openrouter-key-not-real');
  });

  it('should list openrouter in model configs', () => {
    const names = listModelConfigs();
    assert.ok(names.includes('openrouter'));
    assert.ok(names.includes('openrouter-nokey'));
  });
});
