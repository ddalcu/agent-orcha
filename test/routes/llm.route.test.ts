import { describe, it, before, afterEach, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { createTestApp } from '../helpers/mock-fastify.ts';
import { llmRoutes } from '../../src/routes/llm.route.ts';
import { loadLLMConfig, getLLMConfig } from '../../lib/llm/llm-config.ts';
import { LLMFactory } from '../../lib/llm/llm-factory.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, '..', 'fixtures', 'llm.json');

/** Helper to build the tasks mock used by chat/stream routes */
function mockTasks(extra: Record<string, any> = {}) {
  return {
    tasks: {
      getManager: () => ({
        track: () => ({ id: 'task-1' }),
        resolve: () => {},
        reject: () => {},
        registerAbort: () => {},
        unregisterAbort: () => {},
        ...extra,
      }),
    },
  };
}

/** Create a temporary copy of llm.json for tests that mutate config */
function createTempLlmJson(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-test-'));
  const tmpPath = path.join(tmpDir, 'llm.json');
  fs.copyFileSync(fixturePath, tmpPath);
  return tmpPath;
}

describe('llm.route', () => {
  let app: any;

  before(async () => {
    await loadLLMConfig(fixturePath);
  });

  afterEach(async () => {
    // Reload fixture to undo any mutations from PUT/DELETE tests
    await loadLLMConfig(fixturePath);
    if (app) await app.close();
  });

  // ─── redactKey (lines 25-29) + GET /config (lines 91-124) ───

  describe('GET /config — redactKey + config response', () => {
    it('should return config with redacted API keys and provider metadata', async () => {
      const result = await createTestApp(llmRoutes, '/api/llm');
      app = result.app;

      const res = await app.inject({ method: 'GET', url: '/api/llm/config' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);

      assert.equal(body.version, '1.0');
      assert.ok(body.models);
      assert.ok(body.embeddings);

      // String pointer should be passed through as-is
      assert.equal(body.models.default, 'openai');
      assert.equal(body.embeddings.default, 'openai');

      // Gemini has apiKey "test-gemini-key-not-real" — should be redacted to ••••real
      assert.equal(body.models.gemini.apiKey, '••••real');

      // Claude has apiKey "test-anthropic-key-not-real" — should be redacted to ••••real
      assert.equal(body.models.claude.apiKey, '••••real');

      // openai model (no apiKey) — apiKey should be undefined
      assert.equal(body.models.openai.apiKey, undefined);

      // Models should have _provider, _hasEnvKey, _envVar
      assert.ok(body.models.gemini._provider);
      assert.equal(typeof body.models.gemini._hasEnvKey, 'boolean');
      assert.ok(body.models.gemini._envVar);
    });

    it('should redact short keys (<=4 chars) to just dots', async () => {
      const config = getLLMConfig()!;
      const origGeminiKey = (config.models.gemini as any).apiKey;
      (config.models.gemini as any).apiKey = 'ab';

      const result = await createTestApp(llmRoutes, '/api/llm');
      app = result.app;

      const res = await app.inject({ method: 'GET', url: '/api/llm/config' });
      const body = JSON.parse(res.payload);
      assert.equal(body.models.gemini.apiKey, '••••');

      (config.models.gemini as any).apiKey = origGeminiKey;
    });

    it('should pass through env var patterns like ${VAR_NAME}', async () => {
      const config = getLLMConfig()!;
      const origGeminiKey = (config.models.gemini as any).apiKey;
      (config.models.gemini as any).apiKey = '${MY_API_KEY}';

      const result = await createTestApp(llmRoutes, '/api/llm');
      app = result.app;

      const res = await app.inject({ method: 'GET', url: '/api/llm/config' });
      const body = JSON.parse(res.payload);
      assert.equal(body.models.gemini.apiKey, '${MY_API_KEY}');

      (config.models.gemini as any).apiKey = origGeminiKey;
    });

    it('should return empty undefined for key when apiKey is empty/falsy', async () => {
      const config = getLLMConfig()!;
      const origKey = (config.models.gemini as any).apiKey;
      (config.models.gemini as any).apiKey = '';

      const result = await createTestApp(llmRoutes, '/api/llm');
      app = result.app;

      const res = await app.inject({ method: 'GET', url: '/api/llm/config' });
      const body = JSON.parse(res.payload);
      // redactKey('') returns undefined
      assert.equal(body.models.gemini.apiKey, undefined);

      (config.models.gemini as any).apiKey = origKey;
    });

    it('should return empty config when no llm.json is loaded', async () => {
      // Temporarily set the in-memory config to have no models/embeddings
      // by loading a minimal temp config that simulates empty state
      const tmpPath = createTempLlmJson();
      fs.writeFileSync(tmpPath, JSON.stringify({ version: '1.0', models: {}, embeddings: {} }));
      await loadLLMConfig(tmpPath);

      const result = await createTestApp(llmRoutes, '/api/llm');
      app = result.app;

      const res = await app.inject({ method: 'GET', url: '/api/llm/config' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.version, '1.0');
      assert.deepEqual(body.models, {});
      assert.deepEqual(body.embeddings, {});

      fs.rmSync(path.dirname(tmpPath), { recursive: true });
    });
  });

  // ─── PUT /config/models/:name (lines 131-175) ───

  describe('PUT /config/models/:name', () => {
    it('should upsert a model config entry', async () => {
      const tmpPath = createTempLlmJson();
      const result = await createTestApp(llmRoutes, '/api/llm', { llmConfigPath: tmpPath });
      app = result.app;

      const res = await app.inject({
        method: 'PUT',
        url: '/api/llm/config/models/test-model',
        payload: {
          model: 'gpt-4o',
          provider: 'openai',
          temperature: 0.5,
        },
      });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(JSON.parse(res.payload), { ok: true });

      const config = getLLMConfig()!;
      const saved = config.models['test-model'] as any;
      assert.equal(saved.model, 'gpt-4o');
      assert.equal(saved.temperature, 0.5);

      fs.rmSync(path.dirname(tmpPath), { recursive: true });
    });

    it('should set a string pointer via _pointer field', async () => {
      const tmpPath = createTempLlmJson();
      const result = await createTestApp(llmRoutes, '/api/llm', { llmConfigPath: tmpPath });
      app = result.app;

      const res = await app.inject({
        method: 'PUT',
        url: '/api/llm/config/models/default',
        payload: { _pointer: 'gemini' },
      });
      assert.equal(res.statusCode, 200);
      const config = getLLMConfig()!;
      assert.equal(config.models.default, 'gemini');

      fs.rmSync(path.dirname(tmpPath), { recursive: true });
    });

    it('should preserve existing API key when redacted key is sent', async () => {
      const tmpPath = createTempLlmJson();
      const result = await createTestApp(llmRoutes, '/api/llm', { llmConfigPath: tmpPath });
      app = result.app;

      // First set a model with a real API key
      await app.inject({
        method: 'PUT',
        url: '/api/llm/config/models/key-test',
        payload: { model: 'gpt-4o', provider: 'openai', apiKey: 'sk-real-key-12345' },
      });

      // Now update it with a redacted key — should preserve the original
      const res = await app.inject({
        method: 'PUT',
        url: '/api/llm/config/models/key-test',
        payload: { model: 'gpt-4o', provider: 'openai', apiKey: '••••2345' },
      });
      assert.equal(res.statusCode, 200);

      const config = getLLMConfig()!;
      const saved = config.models['key-test'] as any;
      assert.equal(saved.apiKey, 'sk-real-key-12345');

      fs.rmSync(path.dirname(tmpPath), { recursive: true });
    });

    it('should delete apiKey when redacted and no existing key', async () => {
      const tmpPath = createTempLlmJson();
      const result = await createTestApp(llmRoutes, '/api/llm', { llmConfigPath: tmpPath });
      app = result.app;

      const res = await app.inject({
        method: 'PUT',
        url: '/api/llm/config/models/no-key-test',
        payload: { model: 'gpt-4o', provider: 'openai', apiKey: '••••xxxx' },
      });
      assert.equal(res.statusCode, 200);

      const config = getLLMConfig()!;
      const saved = config.models['no-key-test'] as any;
      assert.equal(saved.apiKey, undefined);

      fs.rmSync(path.dirname(tmpPath), { recursive: true });
    });

    it('should strip internal fields (_provider, _hasEnvKey, _envVar)', async () => {
      const tmpPath = createTempLlmJson();
      const result = await createTestApp(llmRoutes, '/api/llm', { llmConfigPath: tmpPath });
      app = result.app;

      const res = await app.inject({
        method: 'PUT',
        url: '/api/llm/config/models/strip-test',
        payload: {
          model: 'gpt-4o',
          provider: 'openai',
          _provider: 'openai',
          _hasEnvKey: true,
          _envVar: 'OPENAI_API_KEY',
        },
      });
      assert.equal(res.statusCode, 200);

      const config = getLLMConfig()!;
      const saved = config.models['strip-test'] as any;
      assert.equal(saved._provider, undefined);
      assert.equal(saved._hasEnvKey, undefined);
      assert.equal(saved._envVar, undefined);

      fs.rmSync(path.dirname(tmpPath), { recursive: true });
    });

    it('should remove empty optional fields (baseUrl, temperature, etc.)', async () => {
      const tmpPath = createTempLlmJson();
      const result = await createTestApp(llmRoutes, '/api/llm', { llmConfigPath: tmpPath });
      app = result.app;

      const res = await app.inject({
        method: 'PUT',
        url: '/api/llm/config/models/empty-fields',
        payload: {
          model: 'gpt-4o',
          provider: 'openai',
          baseUrl: '',
          temperature: null,
          maxTokens: null,
          thinkingBudget: null,
          reasoningBudget: null,
          contextSize: null,
        },
      });
      assert.equal(res.statusCode, 200);

      const config = getLLMConfig()!;
      const saved = config.models['empty-fields'] as any;
      assert.equal(saved.baseUrl, undefined);
      assert.equal(saved.temperature, undefined);
      assert.equal(saved.maxTokens, undefined);

      fs.rmSync(path.dirname(tmpPath), { recursive: true });
    });

    it('should preserve empty apiKey when existing is also empty (no apiKey)', async () => {
      const tmpPath = createTempLlmJson();
      const result = await createTestApp(llmRoutes, '/api/llm', { llmConfigPath: tmpPath });
      app = result.app;

      // Update existing 'fast' which has no apiKey — send empty apiKey
      const res = await app.inject({
        method: 'PUT',
        url: '/api/llm/config/models/fast',
        payload: { model: 'gpt-3.5-turbo', provider: 'openai', apiKey: '' },
      });
      assert.equal(res.statusCode, 200);

      const config = getLLMConfig()!;
      const saved = config.models['fast'] as any;
      // Should not have apiKey at all
      assert.equal(saved.apiKey, undefined);

      fs.rmSync(path.dirname(tmpPath), { recursive: true });
    });
  });

  // ─── DELETE /config/models/:name (lines 183-200) ───

  describe('DELETE /config/models/:name', () => {
    it('should delete a model config entry', async () => {
      const tmpPath = createTempLlmJson();
      const result = await createTestApp(llmRoutes, '/api/llm', { llmConfigPath: tmpPath });
      app = result.app;

      const configBefore = getLLMConfig()!;
      assert.ok(configBefore.models['fast']);

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/llm/config/models/fast',
      });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(JSON.parse(res.payload), { ok: true });

      const configAfter = getLLMConfig()!;
      assert.equal(configAfter.models['fast'], undefined);

      fs.rmSync(path.dirname(tmpPath), { recursive: true });
    });

    it('should return 400 when trying to delete "default"', async () => {
      const result = await createTestApp(llmRoutes, '/api/llm');
      app = result.app;

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/llm/config/models/default',
      });
      assert.equal(res.statusCode, 400);
      const body = JSON.parse(res.payload);
      assert.ok(body.error.includes('Cannot delete the default pointer'));
    });

    it('should return 400 when trying to delete the model that default points to', async () => {
      const result = await createTestApp(llmRoutes, '/api/llm');
      app = result.app;

      // default points to 'openai' in fixture
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/llm/config/models/openai',
      });
      assert.equal(res.statusCode, 400);
      const body = JSON.parse(res.payload);
      assert.ok(body.error.includes('current default'));
    });
  });

  // ─── PUT /config/embeddings/:name (lines 208-238) ───

  describe('PUT /config/embeddings/:name', () => {
    it('should upsert an embedding config entry', async () => {
      const tmpPath = createTempLlmJson();
      const result = await createTestApp(llmRoutes, '/api/llm', { llmConfigPath: tmpPath });
      app = result.app;

      const res = await app.inject({
        method: 'PUT',
        url: '/api/llm/config/embeddings/test-emb',
        payload: {
          model: 'text-embedding-3-large',
          provider: 'openai',
        },
      });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(JSON.parse(res.payload), { ok: true });

      const config = getLLMConfig()!;
      const saved = config.embeddings['test-emb'] as any;
      assert.equal(saved.model, 'text-embedding-3-large');

      fs.rmSync(path.dirname(tmpPath), { recursive: true });
    });

    it('should set a string pointer via _pointer field', async () => {
      const tmpPath = createTempLlmJson();
      const result = await createTestApp(llmRoutes, '/api/llm', { llmConfigPath: tmpPath });
      app = result.app;

      const res = await app.inject({
        method: 'PUT',
        url: '/api/llm/config/embeddings/default',
        payload: { _pointer: 'some-other' },
      });
      assert.equal(res.statusCode, 200);
      const config = getLLMConfig()!;
      assert.equal(config.embeddings.default, 'some-other');

      fs.rmSync(path.dirname(tmpPath), { recursive: true });
    });

    it('should preserve existing API key when redacted key is sent', async () => {
      const tmpPath = createTempLlmJson();
      const result = await createTestApp(llmRoutes, '/api/llm', { llmConfigPath: tmpPath });
      app = result.app;

      // Set embedding with real key
      await app.inject({
        method: 'PUT',
        url: '/api/llm/config/embeddings/key-emb',
        payload: { model: 'text-embedding-3-small', provider: 'openai', apiKey: 'sk-emb-real-key' },
      });

      // Update with redacted key
      const res = await app.inject({
        method: 'PUT',
        url: '/api/llm/config/embeddings/key-emb',
        payload: { model: 'text-embedding-3-small', provider: 'openai', apiKey: '••••-key' },
      });
      assert.equal(res.statusCode, 200);

      const config = getLLMConfig()!;
      const saved = config.embeddings['key-emb'] as any;
      assert.equal(saved.apiKey, 'sk-emb-real-key');

      fs.rmSync(path.dirname(tmpPath), { recursive: true });
    });

    it('should delete apiKey when redacted and no existing key', async () => {
      const tmpPath = createTempLlmJson();
      const result = await createTestApp(llmRoutes, '/api/llm', { llmConfigPath: tmpPath });
      app = result.app;

      const res = await app.inject({
        method: 'PUT',
        url: '/api/llm/config/embeddings/no-key-emb',
        payload: { model: 'text-embedding-3-small', provider: 'openai', apiKey: '••••xxxx' },
      });
      assert.equal(res.statusCode, 200);

      const config = getLLMConfig()!;
      const saved = config.embeddings['no-key-emb'] as any;
      assert.equal(saved.apiKey, undefined);

      fs.rmSync(path.dirname(tmpPath), { recursive: true });
    });

    it('should remove empty optional fields (baseUrl, dimensions)', async () => {
      const tmpPath = createTempLlmJson();
      const result = await createTestApp(llmRoutes, '/api/llm', { llmConfigPath: tmpPath });
      app = result.app;

      const res = await app.inject({
        method: 'PUT',
        url: '/api/llm/config/embeddings/clean-emb',
        payload: {
          model: 'text-embedding-3-small',
          provider: 'openai',
          baseUrl: '',
          dimensions: null,
        },
      });
      assert.equal(res.statusCode, 200);

      const config = getLLMConfig()!;
      const saved = config.embeddings['clean-emb'] as any;
      assert.equal(saved.baseUrl, undefined);
      assert.equal(saved.dimensions, undefined);

      fs.rmSync(path.dirname(tmpPath), { recursive: true });
    });
  });

  // ─── GET /readiness (lines 244-272) ───

  describe('GET /readiness', () => {
    it('should return ready when default model and embedding are configured with key', async () => {
      const origOpenAI = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'test-key';

      const result = await createTestApp(llmRoutes, '/api/llm');
      app = result.app;

      const res = await app.inject({ method: 'GET', url: '/api/llm/readiness' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.ready, true);
      assert.deepEqual(body.issues, []);

      if (origOpenAI === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = origOpenAI;
    });

    it('should report issues when no API key is available', async () => {
      const origOpenAI = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;

      const result = await createTestApp(llmRoutes, '/api/llm');
      app = result.app;

      const res = await app.inject({ method: 'GET', url: '/api/llm/readiness' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.ready, false);
      assert.ok(body.issues.length > 0);

      if (origOpenAI !== undefined) process.env.OPENAI_API_KEY = origOpenAI;
    });

    it('should report no default model/embedding when config is empty', async () => {
      const tmpPath = createTempLlmJson();
      fs.writeFileSync(tmpPath, JSON.stringify({ version: '1.0', models: {}, embeddings: {} }));
      await loadLLMConfig(tmpPath);

      const result = await createTestApp(llmRoutes, '/api/llm');
      app = result.app;

      const res = await app.inject({ method: 'GET', url: '/api/llm/readiness' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.ready, false);
      assert.ok(body.issues.some((i: string) => i.includes('No default model configured')));
      assert.ok(body.issues.some((i: string) => i.includes('No default embedding configured')));

      fs.rmSync(path.dirname(tmpPath), { recursive: true });
    });

    it('should report broken default pointer', async () => {
      const config = getLLMConfig()!;
      const origDefault = config.models.default;
      config.models.default = 'nonexistent-model-xyz';

      const result = await createTestApp(llmRoutes, '/api/llm');
      app = result.app;

      const res = await app.inject({ method: 'GET', url: '/api/llm/readiness' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.ready, false);
      assert.ok(body.issues.some((i: string) => i.includes('broken') || i.includes('not found')));

      config.models.default = origDefault;
    });

    it('should report local model not downloaded when no baseUrl', async () => {
      const config = getLLMConfig()!;
      const origDefault = config.models.default;
      config.models['local-no-base'] = {
        provider: 'local' as any,
        model: 'some-nonexistent-model',
      } as any;
      config.models.default = 'local-no-base';

      const result = await createTestApp(llmRoutes, '/api/llm');
      app = result.app;

      const res = await app.inject({ method: 'GET', url: '/api/llm/readiness' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.ready, false);
      assert.ok(body.issues.some((i: string) => i.includes('not downloaded')));

      config.models.default = origDefault;
      delete config.models['local-no-base'];
    });
  });

  // ─── buildUserContent (lines 49-66) ───

  describe('POST /:name/chat — buildUserContent with attachments', () => {
    it('should handle image attachments', async () => {
      let capturedMessages: any[] = [];
      const mockCreate = mock.method(LLMFactory, 'create', () => ({
        invoke: async (msgs: any) => {
          capturedMessages = msgs;
          return { content: 'Saw your image' };
        },
      }));

      const result = await createTestApp(llmRoutes, '/api/llm', mockTasks());
      app = result.app;

      const res = await app.inject({
        method: 'POST',
        url: '/api/llm/default/chat',
        payload: {
          message: 'What is this?',
          attachments: [
            { data: 'base64imagedata', mediaType: 'image/png' },
          ],
        },
      });
      assert.equal(res.statusCode, 200);
      const lastMsg = capturedMessages[capturedMessages.length - 1];
      assert.ok(Array.isArray(lastMsg.content));
      assert.equal(lastMsg.content[0].type, 'text');
      assert.equal(lastMsg.content[1].type, 'image');
      assert.equal(lastMsg.content[1].mediaType, 'image/png');

      mockCreate.mock.restore();
    });

    it('should skip invalid attachments (missing data/mediaType)', async () => {
      let capturedMessages: any[] = [];
      const mockCreate = mock.method(LLMFactory, 'create', () => ({
        invoke: async (msgs: any) => {
          capturedMessages = msgs;
          return { content: 'ok' };
        },
      }));

      const result = await createTestApp(llmRoutes, '/api/llm', mockTasks());
      app = result.app;

      const res = await app.inject({
        method: 'POST',
        url: '/api/llm/default/chat',
        payload: {
          message: 'Hello',
          attachments: [
            { data: 123, mediaType: 'image/png' },
            { data: 'data', mediaType: 456 },
          ],
        },
      });
      assert.equal(res.statusCode, 200);
      // With only invalid attachments skipped, only the text part remains
      const lastMsg = capturedMessages[capturedMessages.length - 1];
      assert.ok(Array.isArray(lastMsg.content));
      assert.equal(lastMsg.content.length, 1);
      assert.equal(lastMsg.content[0].type, 'text');

      mockCreate.mock.restore();
    });

    it('should handle non-image attachments via extractDocumentText', async () => {
      let capturedMessages: any[] = [];
      const mockCreate = mock.method(LLMFactory, 'create', () => ({
        invoke: async (msgs: any) => {
          capturedMessages = msgs;
          return { content: 'Read your doc' };
        },
      }));

      const result = await createTestApp(llmRoutes, '/api/llm', mockTasks());
      app = result.app;

      // text/plain will go through extractDocumentText — it may succeed or fail
      // depending on the actual implementation. We just verify it doesn't crash
      // and produces a content part.
      const res = await app.inject({
        method: 'POST',
        url: '/api/llm/default/chat',
        payload: {
          message: 'Read this',
          attachments: [
            { data: 'SGVsbG8gV29ybGQ=', mediaType: 'text/plain', name: 'test.txt' },
          ],
        },
      });
      assert.equal(res.statusCode, 200);
      const lastMsg = capturedMessages[capturedMessages.length - 1];
      assert.ok(Array.isArray(lastMsg.content));
      // Should have at least the text part + either extracted doc or failure message
      assert.ok(lastMsg.content.length >= 2);

      mockCreate.mock.restore();
    });

    it('should return plain text when no attachments', async () => {
      let capturedMessages: any[] = [];
      const mockCreate = mock.method(LLMFactory, 'create', () => ({
        invoke: async (msgs: any) => {
          capturedMessages = msgs;
          return { content: 'ok' };
        },
      }));

      const result = await createTestApp(llmRoutes, '/api/llm', mockTasks());
      app = result.app;

      await app.inject({
        method: 'POST',
        url: '/api/llm/default/chat',
        payload: { message: 'Simple text' },
      });
      const lastMsg = capturedMessages[capturedMessages.length - 1];
      assert.equal(lastMsg.content, 'Simple text');

      mockCreate.mock.restore();
    });
  });

  // ─── POST /:name/chat — sessionId storing (lines 329-332) ───

  describe('POST /:name/chat — session management', () => {
    it('should store messages in conversation history when sessionId provided', async () => {
      const addedMessages: any[] = [];
      const mockCreate = mock.method(LLMFactory, 'create', () => ({
        invoke: async () => ({ content: 'AI response text' }),
      }));

      const result = await createTestApp(llmRoutes, '/api/llm', {
        ...mockTasks(),
        memory: {
          getStore: () => ({
            getMessages: () => [],
            addMessage: (_sid: string, msg: any) => addedMessages.push(msg),
          }),
        },
      });
      app = result.app;

      const res = await app.inject({
        method: 'POST',
        url: '/api/llm/default/chat',
        payload: { message: 'Hi there', sessionId: 'session-1' },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(addedMessages.length, 2);
      assert.equal(addedMessages[0].role, 'human');
      assert.equal(addedMessages[1].role, 'ai');

      mockCreate.mock.restore();
    });

    it('should not store messages when no sessionId', async () => {
      const addedMessages: any[] = [];
      const mockCreate = mock.method(LLMFactory, 'create', () => ({
        invoke: async () => ({ content: 'AI response' }),
      }));

      const result = await createTestApp(llmRoutes, '/api/llm', {
        ...mockTasks(),
        memory: {
          getStore: () => ({
            getMessages: () => [],
            addMessage: (_sid: string, msg: any) => addedMessages.push(msg),
          }),
        },
      });
      app = result.app;

      await app.inject({
        method: 'POST',
        url: '/api/llm/default/chat',
        payload: { message: 'Hi' },
      });
      assert.equal(addedMessages.length, 0);

      mockCreate.mock.restore();
    });

    it('should store empty string for non-string response content', async () => {
      const addedMessages: any[] = [];
      const mockCreate = mock.method(LLMFactory, 'create', () => ({
        invoke: async () => ({ content: [{ type: 'text', text: 'parts' }] }),
      }));

      const result = await createTestApp(llmRoutes, '/api/llm', {
        ...mockTasks(),
        memory: {
          getStore: () => ({
            getMessages: () => [],
            addMessage: (_sid: string, msg: any) => addedMessages.push(msg),
          }),
        },
      });
      app = result.app;

      await app.inject({
        method: 'POST',
        url: '/api/llm/default/chat',
        payload: { message: 'Hi', sessionId: 'ses-2' },
      });
      // When response.content is not string, stores ''
      assert.equal(addedMessages[1].content, '');

      mockCreate.mock.restore();
    });
  });

  // ─── POST /:name/stream — reasoning chunks (lines 417-419) ───

  describe('POST /:name/stream — reasoning/thinking chunks', () => {
    it('should emit thinking events for reasoning chunks', async () => {
      const chunks = [
        { content: 'Hello', reasoning: 'Let me think...' },
        { content: ' World' },
      ];
      const mockCreate = mock.method(LLMFactory, 'create', () => ({
        stream: async function* () {
          for (const chunk of chunks) yield chunk;
        },
      }));

      const result = await createTestApp(llmRoutes, '/api/llm', mockTasks());
      app = result.app;

      const res = await app.inject({
        method: 'POST',
        url: '/api/llm/default/stream',
        payload: { message: 'Hi' },
      });
      assert.equal(res.statusCode, 200);
      const payload = res.payload;
      assert.ok(payload.includes('"type":"thinking"'));
      assert.ok(payload.includes('Let me think...'));

      mockCreate.mock.restore();
    });
  });

  // ─── POST /:name/stream — session storage (lines 424-426) ───

  describe('POST /:name/stream — session management', () => {
    it('should store accumulated response in session history', async () => {
      const addedMessages: any[] = [];
      const chunks = [
        { content: 'Hello' },
        { content: ' World' },
      ];
      const mockCreate = mock.method(LLMFactory, 'create', () => ({
        stream: async function* () {
          for (const chunk of chunks) yield chunk;
        },
      }));

      const result = await createTestApp(llmRoutes, '/api/llm', {
        ...mockTasks(),
        memory: {
          getStore: () => ({
            getMessages: () => [],
            addMessage: (_sid: string, msg: any) => addedMessages.push(msg),
          }),
        },
      });
      app = result.app;

      const res = await app.inject({
        method: 'POST',
        url: '/api/llm/default/stream',
        payload: { message: 'Hi', sessionId: 'stream-session' },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(addedMessages.length, 2);
      assert.equal(addedMessages[0].role, 'human');
      assert.equal(addedMessages[1].role, 'ai');
      assert.equal(addedMessages[1].content, 'Hello World');

      mockCreate.mock.restore();
    });

    it('should not store AI message when not aborted but no accumulated content', async () => {
      const addedMessages: any[] = [];
      const mockCreate = mock.method(LLMFactory, 'create', () => ({
        stream: async function* () {
          yield { content: '' };
          yield { content: null };
        },
      }));

      const result = await createTestApp(llmRoutes, '/api/llm', {
        ...mockTasks(),
        memory: {
          getStore: () => ({
            getMessages: () => [],
            addMessage: (_sid: string, msg: any) => addedMessages.push(msg),
          }),
        },
      });
      app = result.app;

      await app.inject({
        method: 'POST',
        url: '/api/llm/default/stream',
        payload: { message: 'Hi', sessionId: 'empty-stream' },
      });
      // Only user message should be stored (accumulated is empty string, falsy)
      assert.equal(addedMessages.length, 1);
      assert.equal(addedMessages[0].role, 'human');

      mockCreate.mock.restore();
    });
  });

  // ─── POST /:name/stream — task_id event ───

  describe('POST /:name/stream — task events', () => {
    it('should include task_id event as first SSE event', async () => {
      const mockCreate = mock.method(LLMFactory, 'create', () => ({
        stream: async function* () {
          yield { content: 'ok' };
        },
      }));

      const result = await createTestApp(llmRoutes, '/api/llm', mockTasks());
      app = result.app;

      const res = await app.inject({
        method: 'POST',
        url: '/api/llm/default/stream',
        payload: { message: 'Hi' },
      });
      const payload = res.payload;
      assert.ok(payload.includes('"type":"task_id"'));
      assert.ok(payload.includes('"taskId":"task-1"'));

      mockCreate.mock.restore();
    });
  });

  // ─── Existing tests preserved below ───

  it('GET / should list LLM configs', async () => {
    const result = await createTestApp(llmRoutes, '/api/llm');
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/llm' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.ok(Array.isArray(body));
    assert.ok(body.length > 0);
    assert.ok(body[0].name);
    assert.ok(body[0].model);
  });

  it('GET /:name should return specific config', async () => {
    const result = await createTestApp(llmRoutes, '/api/llm');
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/llm/default' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.name, 'default');
    assert.ok(body.model);
  });

  it('GET /:name should return 404 for non-existent', async () => {
    const result = await createTestApp(llmRoutes, '/api/llm');
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/llm/nonexistent' });
    assert.equal(res.statusCode, 404);
  });

  it('POST /:name/chat should return 400 for missing message', async () => {
    const result = await createTestApp(llmRoutes, '/api/llm', mockTasks());
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/llm/default/chat',
      payload: {},
    });
    assert.equal(res.statusCode, 400);
  });

  it('POST /:name/stream should return 400 for missing message', async () => {
    const result = await createTestApp(llmRoutes, '/api/llm', mockTasks());
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/llm/default/stream',
      payload: {},
    });
    assert.equal(res.statusCode, 400);
  });

  it('POST /:name/chat should return 400 for non-string message', async () => {
    const result = await createTestApp(llmRoutes, '/api/llm', mockTasks());
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/llm/default/chat',
      payload: { message: 123 },
    });
    assert.equal(res.statusCode, 400);
  });

  it('POST /:name/stream should return 400 for non-string message', async () => {
    const result = await createTestApp(llmRoutes, '/api/llm', mockTasks());
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/llm/default/stream',
      payload: { message: 123 },
    });
    assert.equal(res.statusCode, 400);
  });

  it('GET / should return baseUrl when configured', async () => {
    const result = await createTestApp(llmRoutes, '/api/llm');
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/llm' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    const localModel = body.find((m: any) => m.name === 'local');
    if (localModel) {
      assert.ok(localModel.baseUrl);
    }
    const openaiModel = body.find((m: any) => m.name === 'openai');
    assert.ok(openaiModel, 'openai model should exist (resolved default)');
    assert.equal(openaiModel.baseUrl, null);
  });

  it('POST /:name/chat should return 200 on success', async () => {
    const mockCreate = mock.method(LLMFactory, 'create', () => ({
      invoke: async () => ({ content: 'Hello from LLM' }),
    }));

    const result = await createTestApp(llmRoutes, '/api/llm', mockTasks());
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/llm/default/chat',
      payload: { message: 'Hi' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.output, 'Hello from LLM');
    assert.equal(body.model, 'default');
    mockCreate.mock.restore();
  });

  it('POST /:name/chat should return 429 on rate limit error', async () => {
    const rateLimitError = Object.assign(new Error('rate limit exceeded'), { status: 429 });
    const mockCreate = mock.method(LLMFactory, 'create', () => ({
      invoke: async () => { throw rateLimitError; },
    }));

    const result = await createTestApp(llmRoutes, '/api/llm', mockTasks());
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/llm/default/chat',
      payload: { message: 'Hi' },
    });
    assert.equal(res.statusCode, 429);
    mockCreate.mock.restore();
  });

  it('POST /:name/chat should return 500 on generic error', async () => {
    const mockCreate = mock.method(LLMFactory, 'create', () => ({
      invoke: async () => { throw new Error('Something broke'); },
    }));

    const result = await createTestApp(llmRoutes, '/api/llm', mockTasks());
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/llm/default/chat',
      payload: { message: 'Hi' },
    });
    assert.equal(res.statusCode, 500);
    const body = JSON.parse(res.payload);
    assert.ok(body.error.includes('Something broke'));
    mockCreate.mock.restore();
  });

  it('POST /:name/chat should return 429 on quota error message', async () => {
    const quotaError = Object.assign(new Error('You have exceeded your quota'), { status: 403 });
    const mockCreate = mock.method(LLMFactory, 'create', () => ({
      invoke: async () => { throw quotaError; },
    }));

    const result = await createTestApp(llmRoutes, '/api/llm', mockTasks());
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/llm/default/chat',
      payload: { message: 'Hi' },
    });
    assert.equal(res.statusCode, 429);
    mockCreate.mock.restore();
  });

  it('POST /:name/stream should stream SSE events on success', async () => {
    const chunks = [
      { content: 'Hello' },
      { content: ' World', usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
    ];
    const mockCreate = mock.method(LLMFactory, 'create', () => ({
      stream: async function* () {
        for (const chunk of chunks) yield chunk;
      },
    }));

    const result = await createTestApp(llmRoutes, '/api/llm', mockTasks());
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/llm/default/stream',
      payload: { message: 'Hi' },
    });
    assert.equal(res.statusCode, 200);
    const payload = res.payload;
    assert.ok(payload.includes('data: {"type":"content","content":"Hello"}'));
    assert.ok(payload.includes('data: {"type":"content","content":" World"}'));
    assert.ok(payload.includes('"type":"usage"'));
    assert.ok(payload.includes('"input_tokens":10'));
    assert.ok(payload.includes('[DONE]'));
    mockCreate.mock.restore();
  });

  it('POST /:name/stream should handle errors during streaming', async () => {
    const mockCreate = mock.method(LLMFactory, 'create', () => ({
      stream: async function* () {
        yield { content: 'partial' };
        throw new Error('Stream failed');
      },
    }));

    const result = await createTestApp(llmRoutes, '/api/llm', mockTasks());
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/llm/default/stream',
      payload: { message: 'Hi' },
    });
    const payload = res.payload;
    assert.ok(payload.includes('"error":"Stream failed"'));
    mockCreate.mock.restore();
  });
});
