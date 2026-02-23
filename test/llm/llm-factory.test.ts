import { describe, it, before, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { LLMFactory } from '../../lib/llm/llm-factory.ts';
import { loadLLMConfig } from '../../lib/llm/llm-config.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, '..', 'fixtures', 'llm.json');

describe('LLMFactory', () => {
  before(async () => {
    await loadLLMConfig(fixturePath);
  });

  afterEach(() => {
    LLMFactory.clearCache();
  });

  it('should create an LLM instance for default config', () => {
    const llm = LLMFactory.create('default');
    assert.ok(llm);
    assert.ok(typeof llm.invoke === 'function');
  });

  it('should cache instances and return same reference', () => {
    const llm1 = LLMFactory.create('default');
    const llm2 = LLMFactory.create('default');
    assert.strictEqual(llm1, llm2);
  });

  it('should create different instances for different configs', () => {
    const llm1 = LLMFactory.create('default');
    const llm2 = LLMFactory.create('fast');
    assert.notStrictEqual(llm1, llm2);
  });

  it('should clear cache', () => {
    const llm1 = LLMFactory.create('default');
    LLMFactory.clearCache();
    const llm2 = LLMFactory.create('default');
    assert.notStrictEqual(llm1, llm2);
  });

  it('should create different instances for different temperatures', () => {
    const llm1 = LLMFactory.create({ name: 'default', temperature: 0.1 });
    const llm2 = LLMFactory.create({ name: 'default', temperature: 0.9 });
    assert.notStrictEqual(llm1, llm2);
  });

  it('should throw for unknown model config', () => {
    assert.throws(
      () => LLMFactory.create('nonexistent'),
      /not found/
    );
  });

  it('should create a Gemini instance', () => {
    const llm = LLMFactory.create('gemini');
    assert.ok(llm);
    assert.ok(typeof llm.invoke === 'function');
  });

  it('should create an Anthropic instance', () => {
    const llm = LLMFactory.create('claude');
    assert.ok(llm);
    assert.ok(typeof llm.invoke === 'function');
  });

  it('should create a local/OpenAI-compatible instance', () => {
    const llm = LLMFactory.create('local');
    assert.ok(llm);
    assert.ok(typeof llm.invoke === 'function');
  });

  it('should create OpenAI instance with custom baseUrl', () => {
    const llm = LLMFactory.create('openai-custom');
    assert.ok(llm);
  });

  it('should accept object ref with temperature override', () => {
    const llm = LLMFactory.create({ name: 'gemini', temperature: 0.9 });
    assert.ok(llm);
  });
});
