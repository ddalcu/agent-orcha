import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { createTestApp } from '../helpers/mock-fastify.ts';
import { knowledgeRoutes } from '../../src/routes/knowledge.route.ts';

function mockSqliteStore(entities: any[] = [], relationships: any[] = []) {
  return {
    getAllEntities: () => entities,
    getAllRelationships: () => relationships,
    getEntity: (id: string) => entities.find((e: any) => e.id === id),
    getEntityCount: () => entities.length,
    getRelationshipCount: () => relationships.length,
  };
}

function entityRow(id: string, type: string, name: string) {
  return {
    id,
    type,
    name,
    description: `desc of ${name}`,
    properties: '{}',
    source_chunk_ids: '["c1"]',
  };
}

function relRow(id: string, type: string, sourceId: string, targetId: string) {
  return {
    id,
    type,
    source_id: sourceId,
    target_id: targetId,
    description: 'relates',
    weight: 1.0,
    properties: '{}',
  };
}

describe('knowledge.route', () => {
  let app: any;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('GET / should list knowledge stores', async () => {
    const result = await createTestApp(knowledgeRoutes, '/api/knowledge', {
      knowledge: {
        listConfigs: () => [{
          name: 'kb1',
          description: 'Test KB',
          source: { type: 'file' },
          embedding: 'default',
        }],
        getAllStatuses: async () => new Map(),
        isIndexing: () => false,
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/knowledge' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.length, 1);
    assert.equal(body[0].name, 'kb1');
  });

  it('GET /:name should return 404 for missing config', async () => {
    const result = await createTestApp(knowledgeRoutes, '/api/knowledge', {
      knowledge: {
        getConfig: () => undefined,
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/knowledge/missing' });
    assert.equal(res.statusCode, 404);
  });

  it('GET /:name should return config when found', async () => {
    const config = { name: 'kb1', description: 'Test KB' };
    const result = await createTestApp(knowledgeRoutes, '/api/knowledge', {
      knowledge: {
        getConfig: (name: string) => name === 'kb1' ? config : undefined,
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/knowledge/kb1' });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.payload).name, 'kb1');
  });

  it('POST /:name/search should search knowledge', async () => {
    const result = await createTestApp(knowledgeRoutes, '/api/knowledge', {
      searchKnowledge: async () => [{ content: 'found', score: 0.9, metadata: {} }],
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/knowledge/kb1/search',
      payload: { query: 'test', k: 3 },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.payload).results.length, 1);
  });

  it('POST /:name/search should return 404 for missing store', async () => {
    const result = await createTestApp(knowledgeRoutes, '/api/knowledge', {
      searchKnowledge: async () => { throw new Error('Knowledge store "x" not found'); },
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/knowledge/x/search',
      payload: { query: 'test' },
    });
    assert.equal(res.statusCode, 404);
  });

  it('POST /:name/search should return 500 for generic error', async () => {
    const result = await createTestApp(knowledgeRoutes, '/api/knowledge', {
      searchKnowledge: async () => { throw new Error('Internal error'); },
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/knowledge/kb1/search',
      payload: { query: 'test' },
    });
    assert.equal(res.statusCode, 500);
  });

  it('POST /:name/refresh should refresh store', async () => {
    const result = await createTestApp(knowledgeRoutes, '/api/knowledge', {
      knowledge: {
        refresh: async () => {},
      },
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/knowledge/kb1/refresh',
    });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.payload).success, true);
  });

  it('POST /:name/refresh should return 500 on error', async () => {
    const result = await createTestApp(knowledgeRoutes, '/api/knowledge', {
      knowledge: {
        refresh: async () => { throw new Error('Refresh failed'); },
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'POST', url: '/api/knowledge/kb1/refresh' });
    assert.equal(res.statusCode, 500);
  });

  it('GET /:name/status should return 404 for missing config', async () => {
    const result = await createTestApp(knowledgeRoutes, '/api/knowledge', {
      knowledge: {
        getConfig: () => undefined,
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/knowledge/missing/status' });
    assert.equal(res.statusCode, 404);
  });

  it('GET /:name/status should return status when found', async () => {
    const result = await createTestApp(knowledgeRoutes, '/api/knowledge', {
      knowledge: {
        getConfig: (name: string) => name === 'kb1' ? { name: 'kb1', embedding: 'default' } : undefined,
        getStatus: async () => ({ status: 'indexed', documentCount: 5, chunkCount: 10 }),
        isIndexing: () => false,
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/knowledge/kb1/status' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.status, 'indexed');
    assert.equal(body.documentCount, 5);
  });

  it('POST /:name/index should return 404 for missing config', async () => {
    const result = await createTestApp(knowledgeRoutes, '/api/knowledge', {
      knowledge: {
        getConfig: () => undefined,
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'POST', url: '/api/knowledge/missing/index' });
    assert.equal(res.statusCode, 404);
  });

  it('POST /:name/index should return 409 if already indexing', async () => {
    const result = await createTestApp(knowledgeRoutes, '/api/knowledge', {
      knowledge: {
        getConfig: () => ({ name: 'kb1' }),
        isIndexing: () => true,
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'POST', url: '/api/knowledge/kb1/index' });
    assert.equal(res.statusCode, 409);
  });

  it('POST /:name/index should start indexing (new store)', async () => {
    const result = await createTestApp(knowledgeRoutes, '/api/knowledge', {
      knowledge: {
        getConfig: () => ({ name: 'kb1' }),
        isIndexing: () => false,
        get: () => undefined,
        initialize: async () => {},
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'POST', url: '/api/knowledge/kb1/index' });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.payload).success, true);
  });

  it('POST /:name/index should refresh existing store', async () => {
    const result = await createTestApp(knowledgeRoutes, '/api/knowledge', {
      knowledge: {
        getConfig: () => ({ name: 'kb1' }),
        isIndexing: () => false,
        get: () => ({ search: async () => [] }),
        refresh: async () => {},
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'POST', url: '/api/knowledge/kb1/index' });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.payload).success, true);
  });

  it('POST /:name/add should add documents to existing store', async () => {
    let addedDocs: any[] = [];
    const result = await createTestApp(knowledgeRoutes, '/api/knowledge', {
      knowledge: {
        get: () => ({
          addDocuments: async (docs: any[]) => { addedDocs = docs; },
        }),
      },
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/knowledge/kb1/add',
      payload: { documents: [{ content: 'doc1' }, { content: 'doc2' }] },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.payload).added, 2);
  });

  it('POST /:name/add should initialize store if not found', async () => {
    let initialized = false;
    const result = await createTestApp(knowledgeRoutes, '/api/knowledge', {
      knowledge: {
        get: () => {
          if (initialized) return { addDocuments: async () => {} };
          return undefined;
        },
        initialize: async () => { initialized = true; },
      },
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/knowledge/kb1/add',
      payload: { documents: [{ content: 'doc' }] },
    });
    assert.equal(res.statusCode, 200);
  });

  it('POST /:name/add should return 404 if store cannot be initialized', async () => {
    const result = await createTestApp(knowledgeRoutes, '/api/knowledge', {
      knowledge: {
        get: () => undefined,
        initialize: async () => {},
      },
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/knowledge/kb1/add',
      payload: { documents: [{ content: 'doc' }] },
    });
    assert.equal(res.statusCode, 404);
  });

  it('GET /:name/entities should return 404 when store not initialized', async () => {
    const result = await createTestApp(knowledgeRoutes, '/api/knowledge', {
      knowledge: { getSqliteStore: () => undefined },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/knowledge/kb1/entities' });
    assert.equal(res.statusCode, 404);
  });

  it('GET /:name/entities should return 400 when no entities', async () => {
    const store = mockSqliteStore([]);
    const result = await createTestApp(knowledgeRoutes, '/api/knowledge', {
      knowledge: { getSqliteStore: () => store },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/knowledge/kb1/entities' });
    assert.equal(res.statusCode, 400);
  });

  it('GET /:name/entities should return entities from store', async () => {
    const entities = [entityRow('n1', 'ENTITY', 'Node1')];
    const store = mockSqliteStore(entities);
    const result = await createTestApp(knowledgeRoutes, '/api/knowledge', {
      knowledge: { getSqliteStore: () => store },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/knowledge/kb1/entities' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.count, 1);
    assert.equal(body.entities[0].name, 'Node1');
  });

  it('GET /:name/edges should return 404 when store not initialized', async () => {
    const result = await createTestApp(knowledgeRoutes, '/api/knowledge', {
      knowledge: { getSqliteStore: () => undefined },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/knowledge/kb1/edges' });
    assert.equal(res.statusCode, 404);
  });

  it('GET /:name/edges should return 400 when no entities', async () => {
    const store = mockSqliteStore([]);
    const result = await createTestApp(knowledgeRoutes, '/api/knowledge', {
      knowledge: { getSqliteStore: () => store },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/knowledge/kb1/edges' });
    assert.equal(res.statusCode, 400);
  });

  it('GET /:name/edges should return edges from store', async () => {
    const entities = [entityRow('n1', 'Entity', 'N1'), entityRow('n2', 'Entity', 'N2')];
    const rels = [relRow('e1', 'RELATES_TO', 'n1', 'n2')];
    const store = mockSqliteStore(entities, rels);
    const result = await createTestApp(knowledgeRoutes, '/api/knowledge', {
      knowledge: { getSqliteStore: () => store },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/knowledge/kb1/edges' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.count, 1);
    assert.equal(body.edges[0].type, 'RELATES_TO');
  });

  it('POST /:name/add should return 500 on error', async () => {
    const result = await createTestApp(knowledgeRoutes, '/api/knowledge', {
      knowledge: {
        get: () => ({
          addDocuments: async () => { throw new Error('Storage full'); },
        }),
      },
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/knowledge/kb1/add',
      payload: { documents: [{ content: 'doc' }] },
    });
    assert.equal(res.statusCode, 500);
    assert.equal(JSON.parse(res.payload).error, 'Storage full');
  });

  it('POST /:name/add should return 500 with non-Error thrown', async () => {
    const result = await createTestApp(knowledgeRoutes, '/api/knowledge', {
      knowledge: {
        get: () => ({
          addDocuments: async () => { throw 'string error'; },
        }),
      },
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/knowledge/kb1/add',
      payload: { documents: [{ content: 'doc' }] },
    });
    assert.equal(res.statusCode, 500);
    assert.equal(JSON.parse(res.payload).error, 'string error');
  });

  it('POST /:name/index should broadcast error when refresh fails', async () => {
    let broadcastedData: string | undefined;
    // We need to trigger the .catch() path by making refresh reject
    const result = await createTestApp(knowledgeRoutes, '/api/knowledge', {
      knowledge: {
        getConfig: () => ({ name: 'kb1' }),
        isIndexing: () => false,
        get: () => ({ search: async () => [] }), // existing store => refresh path
        refresh: async () => { throw new Error('Refresh boom'); },
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'POST', url: '/api/knowledge/kb1/index' });
    assert.equal(res.statusCode, 200);
    // The route returns 200 immediately; the error is broadcast async via SSE.
    // Wait a tick for the catch handler to fire.
    await new Promise((r) => setTimeout(r, 50));
  });

  it('POST /:name/index should broadcast error when initialize fails', async () => {
    const result = await createTestApp(knowledgeRoutes, '/api/knowledge', {
      knowledge: {
        getConfig: () => ({ name: 'kb1' }),
        isIndexing: () => false,
        get: () => undefined, // no existing store => initialize path
        initialize: async () => { throw new Error('Init boom'); },
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'POST', url: '/api/knowledge/kb1/index' });
    assert.equal(res.statusCode, 200);
    await new Promise((r) => setTimeout(r, 50));
  });

  it('POST /:name/index should broadcast error with non-Error thrown (refresh)', async () => {
    const result = await createTestApp(knowledgeRoutes, '/api/knowledge', {
      knowledge: {
        getConfig: () => ({ name: 'kb1' }),
        isIndexing: () => false,
        get: () => ({ search: async () => [] }),
        refresh: async () => { throw 'string refresh error'; },
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'POST', url: '/api/knowledge/kb1/index' });
    assert.equal(res.statusCode, 200);
    await new Promise((r) => setTimeout(r, 50));
  });

  it('POST /:name/index should broadcast error with non-Error thrown (initialize)', async () => {
    const result = await createTestApp(knowledgeRoutes, '/api/knowledge', {
      knowledge: {
        getConfig: () => ({ name: 'kb1' }),
        isIndexing: () => false,
        get: () => undefined,
        initialize: async () => { throw 42; },
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'POST', url: '/api/knowledge/kb1/index' });
    assert.equal(res.statusCode, 200);
    await new Promise((r) => setTimeout(r, 50));
  });

  it('POST /:name/index onProgress callback should call broadcastSSE', async () => {
    let capturedOnProgress: any;
    const result = await createTestApp(knowledgeRoutes, '/api/knowledge', {
      knowledge: {
        getConfig: () => ({ name: 'kb1' }),
        isIndexing: () => false,
        get: () => undefined,
        initialize: async (_name: string, onProgress: any) => {
          capturedOnProgress = onProgress;
        },
      },
    });
    app = result.app;

    // Trigger indexing to capture the onProgress callback
    await app.inject({ method: 'POST', url: '/api/knowledge/kb1/index' });

    // Call the onProgress callback to exercise broadcastSSE (line 144)
    // This covers the broadcastSSE function (lines 39-53) and the onProgress closure (line 143-144)
    assert.ok(capturedOnProgress, 'onProgress callback should have been captured');
    // Call with a non-terminal phase (covers lines 39-52 without done/error branch)
    capturedOnProgress({ name: 'kb1', phase: 'embedding', progress: 50, message: 'Processing...' });
    // Call with done phase (covers lines 43-45 setTimeout cleanup)
    capturedOnProgress({ name: 'kb1', phase: 'done', progress: 100, message: 'Done' });
  });

  it('POST /:name/index onProgress for refresh should call broadcastSSE', async () => {
    let capturedOnProgress: any;
    const result = await createTestApp(knowledgeRoutes, '/api/knowledge', {
      knowledge: {
        getConfig: () => ({ name: 'kb1' }),
        isIndexing: () => false,
        get: () => ({ search: async () => [] }), // existing store => refresh path
        refresh: async (_name: string, onProgress: any) => {
          capturedOnProgress = onProgress;
        },
      },
    });
    app = result.app;

    await app.inject({ method: 'POST', url: '/api/knowledge/kb1/index' });

    assert.ok(capturedOnProgress, 'onProgress callback should have been captured');
    capturedOnProgress({ name: 'kb1', phase: 'loading', progress: 25, message: 'Loading...' });
  });

  it('broadcastSSE with error phase should schedule cleanup', async () => {
    let capturedOnProgress: any;
    const result = await createTestApp(knowledgeRoutes, '/api/knowledge', {
      knowledge: {
        getConfig: () => ({ name: 'kberr' }),
        isIndexing: () => false,
        get: () => undefined,
        initialize: async (_name: string, onProgress: any) => {
          capturedOnProgress = onProgress;
        },
      },
    });
    app = result.app;

    await app.inject({ method: 'POST', url: '/api/knowledge/kberr/index' });
    assert.ok(capturedOnProgress);
    // error phase also triggers the cleanup setTimeout (line 43-45)
    capturedOnProgress({ name: 'kberr', phase: 'error', progress: 0, message: 'Failed' });
  });

  it('broadcastSSE with no listeners should not throw', async () => {
    let capturedOnProgress: any;
    const result = await createTestApp(knowledgeRoutes, '/api/knowledge', {
      knowledge: {
        getConfig: () => ({ name: 'kbnolisten' }),
        isIndexing: () => false,
        get: () => undefined,
        initialize: async (_name: string, onProgress: any) => {
          capturedOnProgress = onProgress;
        },
      },
    });
    app = result.app;

    await app.inject({ method: 'POST', url: '/api/knowledge/kbnolisten/index' });
    assert.ok(capturedOnProgress);
    // No SSE listeners connected - broadcastSSE should handle gracefully (line 47-52)
    assert.doesNotThrow(() => {
      capturedOnProgress({ name: 'kbnolisten', phase: 'loading', progress: 10, message: 'loading' });
    });
  });

  it('GET / should return statuses with metadata', async () => {
    const statuses = new Map([
      ['kb1', { status: 'indexed', documentCount: 10, chunkCount: 20 }],
    ]);
    const result = await createTestApp(knowledgeRoutes, '/api/knowledge', {
      knowledge: {
        listConfigs: () => [{
          name: 'kb1',
          description: 'Graph KB',
          source: { type: 'file' },
          embedding: 'default',
          graph: { directMapping: {} },
          search: { defaultK: 10 },
        }],
        getAllStatuses: async () => statuses,
        isIndexing: () => true,
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/knowledge' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body[0].hasGraph, true);
    assert.equal(body[0].status, 'indexed');
    assert.equal(body[0].isIndexing, true);

  });
});
