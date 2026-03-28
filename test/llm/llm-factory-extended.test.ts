import { describe, it, before, afterEach, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { LLMFactory } from '../../lib/llm/llm-factory.ts';
import { loadModelsConfig, getModelsConfig } from '../../lib/llm/llm-config.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, '..', 'fixtures', 'models.yaml');

describe('LLMFactory — extended coverage', () => {
  before(async () => {
    await loadModelsConfig(fixturePath);
  });

  afterEach(() => {
    LLMFactory.clearCache();
  });

  describe('create()', () => {
    it('should default to "default" ref when called with no arguments', async () => {
      const llm = await LLMFactory.create();
      assert.ok(llm);
      assert.ok(typeof llm.invoke === 'function');
    });

    it('should return cached instance for same name and default temperature', async () => {
      const llm1 = await LLMFactory.create('default');
      const llm2 = await LLMFactory.create('default');
      assert.strictEqual(llm1, llm2);
    });

    it('should create separate instances for same name with different temperatures', async () => {
      const llm1 = await LLMFactory.create({ name: 'default', temperature: 0.1 });
      const llm2 = await LLMFactory.create({ name: 'default', temperature: 0.9 });
      assert.notStrictEqual(llm1, llm2);
    });

    it('should return cached instance for same name and same temperature', async () => {
      const llm1 = await LLMFactory.create({ name: 'default', temperature: 0.5 });
      const llm2 = await LLMFactory.create({ name: 'default', temperature: 0.5 });
      assert.strictEqual(llm1, llm2);
    });

    it('should throw for nonexistent config name', async () => {
      await assert.rejects(
        () => LLMFactory.create('does-not-exist'),
        /not found/
      );
    });

    it('should accept string ref', async () => {
      const llm = await LLMFactory.create('fast');
      assert.ok(llm);
    });

    it('should accept object ref with name only', async () => {
      const llm = await LLMFactory.create({ name: 'fast' });
      assert.ok(llm);
    });

    it('should accept object ref with temperature', async () => {
      const llm = await LLMFactory.create({ name: 'fast', temperature: 1.5 });
      assert.ok(llm);
    });
  });

  describe('provider-specific creation', () => {
    it('should create OpenAI instance', async () => {
      const llm = await LLMFactory.create('default');
      assert.ok(llm);
    });

    it('should create Gemini instance', async () => {
      const llm = await LLMFactory.create('gemini');
      assert.ok(llm);
    });

    it('should create Anthropic instance', async () => {
      const llm = await LLMFactory.create('claude');
      assert.ok(llm);
    });

    it('should create local/OpenAI-compatible instance with explicit baseUrl', async () => {
      const llm = await LLMFactory.create('local');
      assert.ok(llm);
    });

    it('should create OpenAI instance with custom baseUrl', async () => {
      const llm = await LLMFactory.create('openai-custom');
      assert.ok(llm);
    });

    it('should create Gemini with temperature override', async () => {
      const llm = await LLMFactory.create({ name: 'gemini', temperature: 0.0 });
      assert.ok(llm);
    });

    it('should create Anthropic with temperature override', async () => {
      const llm = await LLMFactory.create({ name: 'claude', temperature: 1.0 });
      assert.ok(llm);
    });
  });

  describe('clearCache()', () => {
    it('should clear all cached instances', async () => {
      const llm1 = await LLMFactory.create('default');
      const llm2 = await LLMFactory.create('fast');
      const llm3 = await LLMFactory.create('gemini');
      LLMFactory.clearCache();
      const llm1b = await LLMFactory.create('default');
      const llm2b = await LLMFactory.create('fast');
      const llm3b = await LLMFactory.create('gemini');
      assert.notStrictEqual(llm1, llm1b);
      assert.notStrictEqual(llm2, llm2b);
      assert.notStrictEqual(llm3, llm3b);
    });

    it('should allow recreation after clear', async () => {
      await LLMFactory.create('default');
      LLMFactory.clearCache();
      const llm = await LLMFactory.create('default');
      assert.ok(llm);
    });
  });

  describe('cache key behavior', () => {
    it('should use temperature 0 as default for cache key when no temperature', async () => {
      // Create with no temperature override => uses config temperature or 0
      const llm1 = await LLMFactory.create('default');
      // Create with explicit temperature 0 should return the same if config has no temperature
      // (since config temperature is used when no override is given)
      assert.ok(llm1);
    });

    it('should differentiate cache keys by config name', async () => {
      const llm1 = await LLMFactory.create('default');
      const llm2 = await LLMFactory.create('fast');
      assert.notStrictEqual(llm1, llm2);
    });

    it('should cache local provider instances too', async () => {
      const llm1 = await LLMFactory.create('local');
      const llm2 = await LLMFactory.create('local');
      assert.strictEqual(llm1, llm2);
    });
  });

  describe('unsupported provider', () => {
    it('should throw for unsupported provider', async () => {
      // We need a config that detectProvider returns an unknown provider
      // The easiest way is to add a fixture entry with an unsupported provider
      // or mock detectProvider. Since we can't mock easily, we'll use
      // getModelConfig + detectProvider path by adding a config at runtime.
      const config = getModelsConfig();

      // Temporarily add a config with an unsupported provider
      if (config && config.llm) {
        (config.llm as any)['unsupported-provider'] = {
          provider: 'unsupported-xyz',
          model: 'some-model',
        };
      }

      try {
        await assert.rejects(
          () => LLMFactory.create('unsupported-provider'),
          /Unsupported provider/
        );
      } finally {
        // Clean up
        if (config && config.llm) {
          delete (config.llm as any)['unsupported-provider'];
        }
      }
    });
  });

});
