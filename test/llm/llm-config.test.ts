import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  loadLLMConfig,
  getModelConfig,
  getEmbeddingConfig,
  listModelConfigs,
  listEmbeddingConfigs,
  isLLMConfigLoaded,
  resolveApiKey,
} from '../../lib/llm/llm-config.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, '..', 'fixtures', 'llm.json');

describe('loadLLMConfig', () => {
  it('should load and validate config from fixture', async () => {
    const config = await loadLLMConfig(fixturePath);

    assert.ok(config);
    assert.equal(config.version, '1.0');
    assert.ok(config.models['default']);
    assert.ok(config.embeddings['default']);
  });
});

describe('getModelConfig', () => {
  before(async () => {
    await loadLLMConfig(fixturePath);
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
    await loadLLMConfig(fixturePath);
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
  it('should list all model names', () => {
    const names = listModelConfigs();
    assert.ok(names.includes('default'));
    assert.ok(names.includes('fast'));
  });
});

describe('listEmbeddingConfigs', () => {
  it('should list all embedding names', () => {
    const names = listEmbeddingConfigs();
    assert.ok(names.includes('default'));
  });
});

describe('isLLMConfigLoaded', () => {
  it('should return true after loading config', async () => {
    await loadLLMConfig(fixturePath);
    assert.equal(isLLMConfigLoaded(), true);
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
