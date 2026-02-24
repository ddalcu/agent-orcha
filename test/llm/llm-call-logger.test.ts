import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { logLLMCallStart, logLLMCallEnd } from '../../lib/llm/llm-call-logger.ts';

describe('logLLMCallStart', () => {
  it('should return startTime and stats with empty context', () => {
    const result = logLLMCallStart({ caller: 'test-agent' });

    assert.ok(result.startTime > 0);
    assert.equal(result.stats.systemPromptChars, 0);
    assert.equal(result.stats.messageCount, 0);
    assert.equal(result.stats.messageChars, 0);
    assert.equal(result.stats.toolCount, 0);
    assert.equal(result.stats.totalChars, 0);
    assert.equal(result.stats.estimatedTokens, 0);
  });

  it('should compute system prompt chars', () => {
    const result = logLLMCallStart({
      caller: 'test',
      systemPrompt: 'You are a helpful assistant',
    });

    assert.equal(result.stats.systemPromptChars, 'You are a helpful assistant'.length);
  });

  it('should compute message stats', () => {
    const result = logLLMCallStart({
      caller: 'test',
      messages: [
        { content: 'Hello' },
        { content: 'World' },
      ],
    });

    assert.equal(result.stats.messageCount, 2);
    assert.equal(result.stats.messageChars, 10);
  });

  it('should handle string messages', () => {
    const result = logLLMCallStart({
      caller: 'test',
      messages: ['hello' as any],
    });

    assert.equal(result.stats.messageCount, 1);
    assert.equal(result.stats.messageChars, 5);
  });

  it('should compute tool stats', () => {
    const result = logLLMCallStart({
      caller: 'test',
      tools: [
        { name: 'search', description: 'Search the web', schema: { type: 'object' } } as any,
      ],
    });

    assert.equal(result.stats.toolCount, 1);
    assert.ok(result.stats.toolDescriptionChars > 0);
  });

  it('should estimate tokens as totalChars / 4', () => {
    const result = logLLMCallStart({
      caller: 'test',
      systemPrompt: 'a'.repeat(400),
    });

    assert.equal(result.stats.estimatedTokens, 100);
  });
});

describe('logLLMCallEnd', () => {
  it('should log without errors', () => {
    const stats = {
      systemPromptChars: 100,
      messageCount: 5,
      messageChars: 500,
      toolCount: 2,
      toolDescriptionChars: 200,
      totalChars: 800,
      estimatedTokens: 200,
    };

    // Should not throw
    logLLMCallEnd('test', Date.now() - 1000, stats);
  });

  it('should accept optional responseInfo', () => {
    const stats = {
      systemPromptChars: 0,
      messageCount: 0,
      messageChars: 0,
      toolCount: 0,
      toolDescriptionChars: 0,
      totalChars: 0,
      estimatedTokens: 0,
    };

    logLLMCallEnd('test', Date.now() - 500, stats, {
      contentLength: 200,
      messageCount: 1,
    });
  });
});
