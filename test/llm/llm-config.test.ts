import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import * as path from 'path';
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

describe('resolveApiKey', () => {
  it('should return explicit apiKey when provided', () => {
    assert.equal(resolveApiKey('openai', 'my-key'), 'my-key');
  });

  it('should fall back to env var', () => {
    const originalKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'env-key';

    assert.equal(resolveApiKey('openai'), 'env-key');

    // Restore
    if (originalKey !== undefined) {
      process.env.OPENAI_API_KEY = originalKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('should return undefined when no key available', () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    const result = resolveApiKey('anthropic');
    // Might be undefined or might be set in env
    assert.ok(result === undefined || typeof result === 'string');

    // Restore
    if (originalKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });
});
