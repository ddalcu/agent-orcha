import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { detectProvider } from '../../lib/llm/provider-detector.ts';

describe('detectProvider', () => {
  it('should return explicit provider when set', () => {
    assert.equal(detectProvider({ provider: 'anthropic', model: 'gpt-4' }), 'anthropic');
    assert.equal(detectProvider({ provider: 'gemini', model: 'gpt-4' }), 'gemini');
    assert.equal(detectProvider({ provider: 'local', model: 'gpt-4' }), 'local');
  });

  it('should detect openai from baseUrl', () => {
    assert.equal(
      detectProvider({ model: 'gpt-4', baseUrl: 'https://api.openai.com/v1' }),
      'openai'
    );
  });

  it('should detect gemini from native Google baseUrl', () => {
    assert.equal(
      detectProvider({ model: 'gemini-pro', baseUrl: 'https://generativelanguage.googleapis.com/v1' }),
      'gemini'
    );
  });

  it('should detect local when Google baseUrl has /openai/ path', () => {
    assert.equal(
      detectProvider({ model: 'gemini-pro', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/' }),
      'local'
    );
  });

  it('should detect anthropic from baseUrl', () => {
    assert.equal(
      detectProvider({ model: 'claude-3', baseUrl: 'https://api.anthropic.com/v1' }),
      'anthropic'
    );
  });

  it('should return local for unknown baseUrl', () => {
    assert.equal(
      detectProvider({ model: 'llama3', baseUrl: 'http://localhost:11434/v1' }),
      'local'
    );
  });

  it('should detect openai from model name pattern', () => {
    assert.equal(detectProvider({ model: 'gpt-4o-mini' }), 'openai');
    assert.equal(detectProvider({ model: 'gpt-3.5-turbo' }), 'openai');
  });

  it('should detect gemini from model name pattern', () => {
    assert.equal(detectProvider({ model: 'gemini-pro' }), 'gemini');
    assert.equal(detectProvider({ model: 'gemini-1.5-flash' }), 'gemini');
  });

  it('should detect anthropic from model name pattern', () => {
    assert.equal(detectProvider({ model: 'claude-3-opus' }), 'anthropic');
    assert.equal(detectProvider({ model: 'claude-3.5-sonnet' }), 'anthropic');
  });

  it('should default to openai for unrecognized model', () => {
    assert.equal(detectProvider({ model: 'unknown-model' }), 'openai');
  });
});
