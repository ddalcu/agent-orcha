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

  it('should create an LLM instance for default config', async () => {
    const llm = await LLMFactory.create('default');
    assert.ok(llm);
    assert.ok(typeof llm.invoke === 'function');
  });

  it('should cache instances and return same reference', async () => {
    const llm1 = await LLMFactory.create('default');
    const llm2 = await LLMFactory.create('default');
    assert.strictEqual(llm1, llm2);
  });

  it('should create different instances for different configs', async () => {
    const llm1 = await LLMFactory.create('default');
    const llm2 = await LLMFactory.create('fast');
    assert.notStrictEqual(llm1, llm2);
  });

  it('should clear cache', async () => {
    const llm1 = await LLMFactory.create('default');
    LLMFactory.clearCache();
    const llm2 = await LLMFactory.create('default');
    assert.notStrictEqual(llm1, llm2);
  });

  it('should create different instances for different temperatures', async () => {
    const llm1 = await LLMFactory.create({ name: 'default', temperature: 0.1 });
    const llm2 = await LLMFactory.create({ name: 'default', temperature: 0.9 });
    assert.notStrictEqual(llm1, llm2);
  });

  it('should throw for unknown model config', async () => {
    await assert.rejects(
      () => LLMFactory.create('nonexistent'),
      /not found/
    );
  });

  it('should create a Gemini instance', async () => {
    const llm = await LLMFactory.create('gemini');
    assert.ok(llm);
    assert.ok(typeof llm.invoke === 'function');
  });

  it('should create an Anthropic instance', async () => {
    const llm = await LLMFactory.create('claude');
    assert.ok(llm);
    assert.ok(typeof llm.invoke === 'function');
  });

  it('should create a local/OpenAI-compatible instance', async () => {
    const llm = await LLMFactory.create('local');
    assert.ok(llm);
    assert.ok(typeof llm.invoke === 'function');
  });

  it('should create OpenAI instance with custom baseUrl', async () => {
    const llm = await LLMFactory.create('openai-custom');
    assert.ok(llm);
  });

  it('should accept object ref with temperature override', async () => {
    const llm = await LLMFactory.create({ name: 'gemini', temperature: 0.9 });
    assert.ok(llm);
  });
});
