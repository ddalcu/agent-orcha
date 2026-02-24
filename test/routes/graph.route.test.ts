import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { createTestApp } from '../helpers/mock-fastify.ts';
import { graphRoutes } from '../../src/routes/graph.route.ts';

function entityRow(id: string, type: string, name: string, props: Record<string, unknown> = {}) {
  return {
    id,
    type,
    name,
    description: `Description of ${name}`,
    properties: JSON.stringify(props),
    source_chunk_ids: '[]',
  };
}

function relRow(id: string, type: string, sourceId: string, targetId: string) {
  return {
    id,
    type,
    source_id: sourceId,
    target_id: targetId,
    description: '',
    weight: 1,
    properties: '{}',
  };
}

function mockSqliteStore(entities: any[] = [], relationships: any[] = [], chunkCount = 0) {
  return {
    getAllEntities: () => entities,
    getAllRelationships: () => relationships,
    getEntity: (id: string) => entities.find((e: any) => e.id === id),
    getNeighborhood: (id: string, _depth: number) => {
      return { entities, relationships };
    },
    getChunkCount: () => chunkCount,
    getEntityCount: () => entities.length,
    getRelationshipCount: () => relationships.length,
  };
}

describe('graph.route', () => {
  let app: any;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('GET /config should return configured: false when no stores', async () => {
    const result = await createTestApp(graphRoutes, '/api/graph');
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/graph/config' });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.payload).configured, false);
  });

  it('GET /config should return configured: true when stores exist', async () => {
    const store = mockSqliteStore([entityRow('e1', 'Entity', 'E1')]);
    const result = await createTestApp(graphRoutes, '/api/graph', {
      knowledge: {
        listConfigs: () => [{ name: 'test' }],
        getSqliteStore: () => store,
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/graph/config' });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.payload).configured, true);
  });

  it('GET /full should return 404 when no stores', async () => {
    const result = await createTestApp(graphRoutes, '/api/graph');
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/graph/full' });
    assert.equal(res.statusCode, 404);
  });

  it('GET /full should return KB nodes, entity nodes, CONTAINS edges, and relationship edges', async () => {
    const entities = [
      entityRow('n1', 'Entity', 'N1'),
      entityRow('n2', 'Entity', 'N2'),
    ];
    const rels = [
      relRow('e1', 'RELATED', 'n1', 'n2'),
    ];
    const store = mockSqliteStore(entities, rels);
    const result = await createTestApp(graphRoutes, '/api/graph', {
      knowledge: {
        listConfigs: () => [{ name: 'test' }],
        getSqliteStore: () => store,
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/graph/full' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);

    // 1 KB node + 2 entity nodes
    assert.equal(body.nodes.length, 3);
    assert.equal(body.nodes[0].type, 'KnowledgeBase');
    assert.equal(body.nodes[0].id, 'kb::test');

    // 2 CONTAINS edges + 1 RELATED edge
    assert.equal(body.edges.length, 3);
    const containsEdges = body.edges.filter((e: any) => e.type === 'CONTAINS');
    assert.equal(containsEdges.length, 2);
    assert.equal(containsEdges[0].source, 'kb::test');
    const relatedEdges = body.edges.filter((e: any) => e.type === 'RELATED');
    assert.equal(relatedEdges.length, 1);
  });

  it('GET /full should apply limit to entity nodes only', async () => {
    const entities = Array.from({ length: 10 }, (_, i) =>
      entityRow(`n${i}`, 'Entity', `N${i}`)
    );
    const store = mockSqliteStore(entities);
    const result = await createTestApp(graphRoutes, '/api/graph', {
      knowledge: {
        listConfigs: () => [{ name: 'test' }],
        getSqliteStore: () => store,
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/graph/full?limit=3' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    // 1 KB node + 3 limited entity nodes
    assert.equal(body.nodes.length, 4);
    assert.equal(body.nodes.filter((n: any) => n.type === 'KnowledgeBase').length, 1);
    // 3 CONTAINS edges (one per limited entity)
    assert.equal(body.edges.filter((e: any) => e.type === 'CONTAINS').length, 3);
  });

  it('GET /neighbors/:nodeId should return 404 when no stores', async () => {
    const result = await createTestApp(graphRoutes, '/api/graph');
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/graph/neighbors/n1' });
    assert.equal(res.statusCode, 404);
  });

  it('GET /neighbors/:nodeId should return neighbors when found', async () => {
    const entities = [
      entityRow('n1', 'Entity', 'N1'),
      entityRow('n2', 'Entity', 'N2'),
    ];
    const rels = [relRow('e1', 'RELATED', 'n1', 'n2')];
    const store = mockSqliteStore(entities, rels);
    const result = await createTestApp(graphRoutes, '/api/graph', {
      knowledge: {
        listConfigs: () => [{ name: 'test' }],
        getSqliteStore: () => store,
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/graph/neighbors/n1' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.nodes.length, 2);
    assert.equal(body.edges.length, 1);
  });

  it('GET /neighbors/:nodeId should expand a KB node and return its entities with CONTAINS edges', async () => {
    const entities = [
      entityRow('n1', 'Person', 'Alice'),
      entityRow('n2', 'Person', 'Bob'),
    ];
    const rels = [relRow('r1', 'KNOWS', 'n1', 'n2')];
    const store = mockSqliteStore(entities, rels);
    const result = await createTestApp(graphRoutes, '/api/graph', {
      knowledge: {
        listConfigs: () => [{ name: 'social' }],
        getSqliteStore: (name: string) => name === 'social' ? store : undefined,
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/graph/neighbors/kb%3A%3Asocial' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.nodes.length, 2);
    const containsEdges = body.edges.filter((e: any) => e.type === 'CONTAINS');
    assert.equal(containsEdges.length, 2);
    assert.equal(containsEdges[0].source, 'kb::social');
    const knowsEdges = body.edges.filter((e: any) => e.type === 'KNOWS');
    assert.equal(knowsEdges.length, 1);
  });

  it('GET /neighbors/:nodeId should return empty for KB node with no store', async () => {
    const result = await createTestApp(graphRoutes, '/api/graph', {
      knowledge: {
        listConfigs: () => [{ name: 'empty' }],
        getSqliteStore: () => undefined,
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/graph/neighbors/kb%3A%3Aempty' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.deepEqual(body.nodes, []);
    assert.deepEqual(body.edges, []);
  });

  it('GET /neighbors/:nodeId should return empty when node not found', async () => {
    const store = mockSqliteStore([entityRow('n1', 'Entity', 'N1')]);
    const result = await createTestApp(graphRoutes, '/api/graph', {
      knowledge: {
        listConfigs: () => [{ name: 'test' }],
        getSqliteStore: () => store,
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/graph/neighbors/missing' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.nodes.length, 0);
  });

  it('GET /full should return KB nodes even when no entities exist', async () => {
    const store = mockSqliteStore([], [], 50);
    const result = await createTestApp(graphRoutes, '/api/graph', {
      knowledge: {
        listConfigs: () => [{ name: 'transcripts' }],
        getSqliteStore: () => store,
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/graph/full' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.nodes.length, 1);
    assert.equal(body.nodes[0].type, 'KnowledgeBase');
    assert.deepEqual(body.edges, []);
  });

  // --- /config with vector-only stores ---

  it('GET /config should return configured: true for vector-only stores (no entities)', async () => {
    const result = await createTestApp(graphRoutes, '/api/graph', {
      knowledge: {
        listConfigs: () => [{ name: 'transcripts', description: 'Meeting transcripts', source: { type: 'directory' } }],
        getSqliteStore: () => mockSqliteStore([], [], 50),
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/graph/config' });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.payload).configured, true);
  });

  // --- /knowledge-bases ---

  it('GET /knowledge-bases should return empty nodes when no configs', async () => {
    const result = await createTestApp(graphRoutes, '/api/graph');
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/graph/knowledge-bases' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.deepEqual(body.nodes, []);
    assert.deepEqual(body.edges, []);
  });

  it('GET /knowledge-bases should return all KB configs as nodes', async () => {
    const configs = [
      { name: 'docs', description: 'Documentation', source: { type: 'directory' }, graph: { extraction: {} } },
      { name: 'transcripts', description: 'Meeting transcripts', source: { type: 'web' } },
    ];
    const stores: Record<string, any> = {
      docs: mockSqliteStore([entityRow('e1', 'Entity', 'E1')], [], 10),
      transcripts: mockSqliteStore([], [], 50),
    };

    const result = await createTestApp(graphRoutes, '/api/graph', {
      knowledge: {
        listConfigs: () => configs,
        getSqliteStore: (name: string) => stores[name],
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/graph/knowledge-bases' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.nodes.length, 2);
    assert.deepEqual(body.edges, []);

    const docsNode = body.nodes.find((n: any) => n.name === 'docs');
    assert.equal(docsNode.id, 'kb::docs');
    assert.equal(docsNode.type, 'KnowledgeBase');
    assert.equal(docsNode.description, 'Documentation');
    assert.equal(docsNode.properties.sourceType, 'directory');
    assert.equal(docsNode.properties.hasGraph, true);
    assert.equal(docsNode.properties.chunkCount, 10);
    assert.equal(docsNode.properties.entityCount, 1);

    const transcriptsNode = body.nodes.find((n: any) => n.name === 'transcripts');
    assert.equal(transcriptsNode.id, 'kb::transcripts');
    assert.equal(transcriptsNode.properties.sourceType, 'web');
    assert.equal(transcriptsNode.properties.hasGraph, false);
    assert.equal(transcriptsNode.properties.chunkCount, 50);
    assert.equal(transcriptsNode.properties.entityCount, 0);
  });

  it('GET /knowledge-bases should handle stores without sqlite backing', async () => {
    const result = await createTestApp(graphRoutes, '/api/graph', {
      knowledge: {
        listConfigs: () => [{ name: 'new-kb', description: 'Not yet indexed', source: { type: 'file' } }],
        getSqliteStore: () => undefined,
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/graph/knowledge-bases' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.nodes.length, 1);
    assert.equal(body.nodes[0].properties.chunkCount, 0);
    assert.equal(body.nodes[0].properties.entityCount, 0);
    assert.equal(body.nodes[0].properties.edgeCount, 0);
  });
});
