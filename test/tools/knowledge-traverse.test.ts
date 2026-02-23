import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createKnowledgeTraverseTool } from '../../lib/tools/built-in/knowledge-traverse.tool.ts';
import type { EntityRow, RelationshipRow } from '../../lib/knowledge/sqlite-store.ts';

// --- Realistic mock data: e-commerce product catalog ---

const ENTITIES: EntityRow[] = [
  {
    id: 'product::1',
    type: 'Product',
    name: 'Ergonomic Wireless Keyboard',
    description: 'Low-profile mechanical keyboard with Bluetooth 5.0',
    properties: JSON.stringify({ sku: 'KB-ERG-001', price: 89.99 }),
    source_chunk_ids: '[]',
  },
  {
    id: 'product::2',
    type: 'Product',
    name: 'Compact Mechanical Numpad',
    description: 'Hot-swappable numpad with RGB',
    properties: JSON.stringify({ sku: 'KB-NUM-002', price: 49.99 }),
    source_chunk_ids: '[]',
  },
  {
    id: 'category::10',
    type: 'Category',
    name: 'Peripherals',
    description: 'Computer peripherals and accessories',
    properties: JSON.stringify({ slug: 'peripherals' }),
    source_chunk_ids: '[]',
  },
  {
    id: 'brand::100',
    type: 'Brand',
    name: 'KeyTech',
    description: 'Premium keyboard manufacturer',
    properties: JSON.stringify({ country: 'Japan' }),
    source_chunk_ids: '[]',
  },
];

const RELATIONSHIPS: RelationshipRow[] = [
  {
    id: 'rel::1',
    type: 'BELONGS_TO',
    source_id: 'product::1',
    target_id: 'category::10',
    description: 'Product belongs to category',
    weight: 1,
    properties: '{}',
  },
  {
    id: 'rel::2',
    type: 'BELONGS_TO',
    source_id: 'product::2',
    target_id: 'category::10',
    description: 'Product belongs to category',
    weight: 1,
    properties: '{}',
  },
  {
    id: 'rel::3',
    type: 'MADE_BY',
    source_id: 'product::1',
    target_id: 'brand::100',
    description: 'Product made by brand',
    weight: 1,
    properties: '{}',
  },
];

function catalogConfig() {
  return {
    name: 'catalog',
    description: 'Product catalog with categories and brands',
    graph: {
      directMapping: {
        entities: [
          { type: 'Product', idColumn: 'id', nameColumn: 'name', properties: ['sku', 'price'] },
          { type: 'Category', idColumn: 'category_id', nameColumn: 'category_name', properties: ['slug'] },
          { type: 'Brand', idColumn: 'brand_id', nameColumn: 'brand_name', properties: ['country'] },
        ],
        relationships: [
          { type: 'BELONGS_TO', source: 'Product', target: 'Category', sourceIdColumn: 'id', targetIdColumn: 'category_id' },
          { type: 'MADE_BY', source: 'Product', target: 'Brand', sourceIdColumn: 'id', targetIdColumn: 'brand_id' },
        ],
      },
    },
  } as any;
}

function mockSqliteStore(overrides: Record<string, any> = {}) {
  return {
    getAllEntities: () => ENTITIES,
    getAllRelationships: () => RELATIONSHIPS,
    getEntity: (id: string) => ENTITIES.find(e => e.id === id),
    getNeighborhood: () => ({ entities: [], relationships: [] }),
    getEntityCount: () => ENTITIES.length,
    ...overrides,
  } as any;
}

describe('createKnowledgeTraverseTool', () => {
  it('should create a tool with correct name and schema info in description', () => {
    const tool = createKnowledgeTraverseTool('catalog', catalogConfig(), mockSqliteStore());
    assert.equal(tool.name, 'knowledge_traverse_catalog');
    assert.ok(tool.description.includes('Product'));
    assert.ok(tool.description.includes('BELONGS_TO'));
  });

  it('should require entityName or entityId', async () => {
    const tool = createKnowledgeTraverseTool('catalog', catalogConfig(), mockSqliteStore());
    const result = await tool.invoke({}) as string;
    assert.ok(result.includes('Provide either'));
  });

  it('should traverse by entity ID and return neighborhood', async () => {
    const store = mockSqliteStore({
      getNeighborhood: () => ({
        entities: [ENTITIES[0]!, ENTITIES[2]!, ENTITIES[3]!], // keyboard, Peripherals, KeyTech
        relationships: [RELATIONSHIPS[0]!, RELATIONSHIPS[2]!], // BELONGS_TO, MADE_BY
      }),
    });
    const tool = createKnowledgeTraverseTool('catalog', catalogConfig(), store);
    const result = await tool.invoke({ entityId: 'product::1' }) as string;

    assert.ok(result.includes('Ergonomic Wireless Keyboard'));
    assert.ok(result.includes('Peripherals'));
    assert.ok(result.includes('KeyTech'));
    assert.ok(result.includes('BELONGS_TO'));
    assert.ok(result.includes('MADE_BY'));
    assert.ok(result.includes('depth=1'));
  });

  it('should find entity by name (case-insensitive) and traverse', async () => {
    const store = mockSqliteStore({
      getNeighborhood: () => ({
        entities: [ENTITIES[0]!, ENTITIES[2]!],
        relationships: [RELATIONSHIPS[0]!],
      }),
    });
    const tool = createKnowledgeTraverseTool('catalog', catalogConfig(), store);
    const result = await tool.invoke({ entityName: 'ergonomic' }) as string;
    assert.ok(result.includes('Peripherals'));
    assert.ok(result.includes('BELONGS_TO'));
  });

  it('should return not-found for unknown entity name', async () => {
    const tool = createKnowledgeTraverseTool('catalog', catalogConfig(), mockSqliteStore());
    const result = await tool.invoke({ entityName: 'nonexistent-gadget' }) as string;
    assert.ok(result.includes('No entity found'));
    assert.ok(result.includes('nonexistent-gadget'));
  });

  it('should return no-neighbors when entity has no connections', async () => {
    const store = mockSqliteStore({
      getNeighborhood: () => ({ entities: [], relationships: [] }),
    });
    const tool = createKnowledgeTraverseTool('catalog', catalogConfig(), store);
    const result = await tool.invoke({ entityId: 'brand::999' }) as string;
    assert.ok(result.includes('No neighbors'));
  });

  it('should group nodes by type in output', async () => {
    const store = mockSqliteStore({
      getNeighborhood: () => ({
        entities: [ENTITIES[0]!, ENTITIES[1]!, ENTITIES[2]!, ENTITIES[3]!],
        relationships: RELATIONSHIPS,
      }),
    });
    const tool = createKnowledgeTraverseTool('catalog', catalogConfig(), store);
    const result = await tool.invoke({ entityId: 'category::10' }) as string;
    assert.ok(result.includes('[Product] (2)'));
    assert.ok(result.includes('[Category] (1)'));
    assert.ok(result.includes('[Brand] (1)'));
  });

  it('should respect depth parameter and clamp to 1-3', async () => {
    let receivedDepth: number | undefined;
    const store = mockSqliteStore({
      getNeighborhood: (_id: string, depth: number) => {
        receivedDepth = depth;
        return { entities: [ENTITIES[0]!], relationships: [] };
      },
    });
    const tool = createKnowledgeTraverseTool('catalog', catalogConfig(), store);

    await tool.invoke({ entityId: 'product::1', depth: 2 });
    assert.equal(receivedDepth, 2);

    await tool.invoke({ entityId: 'product::1', depth: 5 });
    assert.equal(receivedDepth, 3); // clamped to max

    await tool.invoke({ entityId: 'product::1', depth: 0 });
    assert.equal(receivedDepth, 1); // clamped to min
  });

  it('should handle traversal errors gracefully', async () => {
    const store = mockSqliteStore({
      getNeighborhood: () => { throw new Error('SQLite disk I/O error'); },
    });
    const tool = createKnowledgeTraverseTool('catalog', catalogConfig(), store);
    const result = await tool.invoke({ entityId: 'product::1' }) as string;
    assert.ok(result.includes('Traversal error'));
    assert.ok(result.includes('SQLite disk I/O error'));
  });

  it('should handle name search errors gracefully', async () => {
    const store = mockSqliteStore({
      getAllEntities: () => { throw new Error('Table locked'); },
    });
    const tool = createKnowledgeTraverseTool('catalog', catalogConfig(), store);
    const result = await tool.invoke({ entityName: 'keyboard' }) as string;
    assert.ok(result.includes('Error searching'));
  });

  it('should prefer entityId over entityName when both provided', async () => {
    let receivedId: string | undefined;
    const store = mockSqliteStore({
      getNeighborhood: (id: string) => {
        receivedId = id;
        return { entities: [ENTITIES[0]!], relationships: [] };
      },
    });
    const tool = createKnowledgeTraverseTool('catalog', catalogConfig(), store);
    await tool.invoke({ entityId: 'product::1', entityName: 'something-else' });
    assert.equal(receivedId, 'product::1');
  });

  it('should truncate large neighborhoods and indicate truncation', async () => {
    const manyEntities = Array.from({ length: 60 }, (_, i) => ({
      id: `product::${i}`,
      type: 'Product',
      name: `Product ${i}`,
      description: `Product number ${i}`,
      properties: '{}',
      source_chunk_ids: '[]',
    }));
    const store = mockSqliteStore({
      getNeighborhood: () => ({ entities: manyEntities, relationships: [] }),
    });
    const tool = createKnowledgeTraverseTool('catalog', catalogConfig(), store);
    const result = await tool.invoke({ entityId: 'category::10' }) as string;
    assert.ok(result.includes('truncated from 60'));
    assert.ok(result.includes('50 nodes'));
  });
});
