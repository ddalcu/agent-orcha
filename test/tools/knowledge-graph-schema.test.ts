import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createKnowledgeGraphSchemaTool } from '../../lib/tools/built-in/knowledge-graph-schema.tool.ts';
import type { EntityRow, RelationshipRow } from '../../lib/knowledge/sqlite-store.ts';

// --- Realistic mock data: e-commerce product catalog ---

const ENTITIES: EntityRow[] = [
  {
    id: 'product::1',
    type: 'Product',
    name: 'Ergonomic Wireless Keyboard',
    description: 'Low-profile mechanical keyboard with Bluetooth 5.0',
    properties: JSON.stringify({ sku: 'KB-ERG-001', price: 89.99, inStock: true }),
    source_chunk_ids: '[]',
  },
  {
    id: 'product::2',
    type: 'Product',
    name: 'Compact Mechanical Numpad',
    description: 'Hot-swappable numpad with RGB backlighting',
    properties: JSON.stringify({ sku: 'KB-NUM-002', price: 49.99, inStock: true }),
    source_chunk_ids: '[]',
  },
  {
    id: 'product::3',
    type: 'Product',
    name: 'Ultra-Wide Curved Monitor',
    description: '34" 3440x1440 144Hz monitor with USB-C hub',
    properties: JSON.stringify({ sku: 'MON-UW-034', price: 699.99, inStock: false }),
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
    id: 'category::20',
    type: 'Category',
    name: 'Monitors',
    description: 'Display monitors and screens',
    properties: JSON.stringify({ slug: 'monitors' }),
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
    type: 'BELONGS_TO',
    source_id: 'product::3',
    target_id: 'category::20',
    description: 'Product belongs to category',
    weight: 1,
    properties: '{}',
  },
  {
    id: 'rel::4',
    type: 'MADE_BY',
    source_id: 'product::1',
    target_id: 'brand::100',
    description: 'Product made by brand',
    weight: 1,
    properties: '{}',
  },
];

function catalogConfig(graphOverrides: Record<string, any> = {}) {
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
      ...graphOverrides,
    },
  } as any;
}

function mockSqliteStore(entities: EntityRow[] = ENTITIES, relationships: RelationshipRow[] = RELATIONSHIPS) {
  return {
    getAllEntities: () => entities,
    getAllRelationships: () => relationships,
    getEntityCount: () => entities.length,
    getRelationshipCount: () => relationships.length,
  } as any;
}

describe('createKnowledgeGraphSchemaTool', () => {
  it('should create a tool with correct name', () => {
    const tool = createKnowledgeGraphSchemaTool('catalog', catalogConfig(), mockSqliteStore());
    assert.equal(tool.name, 'knowledge_graph_schema_catalog');
  });

  it('should return entity types with correct counts', async () => {
    const tool = createKnowledgeGraphSchemaTool('catalog', catalogConfig(), mockSqliteStore());
    const result = await tool.invoke({}) as string;
    assert.ok(result.includes('Product (3 entities)'));
    assert.ok(result.includes('Category (2 entities)'));
    assert.ok(result.includes('Brand (1 entities)'));
  });

  it('should return relationship types with correct counts', async () => {
    const tool = createKnowledgeGraphSchemaTool('catalog', catalogConfig(), mockSqliteStore());
    const result = await tool.invoke({}) as string;
    assert.ok(result.includes('BELONGS_TO (3 relationships)'));
    assert.ok(result.includes('MADE_BY (1 relationships)'));
  });

  it('should show totals', async () => {
    const tool = createKnowledgeGraphSchemaTool('catalog', catalogConfig(), mockSqliteStore());
    const result = await tool.invoke({}) as string;
    assert.ok(result.includes('6 entities, 4 relationships'));
  });

  it('should show property keys per entity type', async () => {
    const tool = createKnowledgeGraphSchemaTool('catalog', catalogConfig(), mockSqliteStore());
    const result = await tool.invoke({}) as string;
    assert.ok(result.includes('sku'));
    assert.ok(result.includes('price'));
    assert.ok(result.includes('slug'));
    assert.ok(result.includes('country'));
  });

  it('should show examples when includeExamples is true', async () => {
    const tool = createKnowledgeGraphSchemaTool('catalog', catalogConfig(), mockSqliteStore());
    const result = await tool.invoke({ includeExamples: true }) as string;
    assert.ok(result.includes('Example: Ergonomic Wireless Keyboard'));
    assert.ok(result.includes('Example: Peripherals'));
    assert.ok(result.includes('Example: KeyTech'));
    // relationships should also have examples
    assert.ok(result.includes('(product::1) -[BELONGS_TO]-> (category::10)'));
  });

  it('should NOT show examples when includeExamples is false', async () => {
    const tool = createKnowledgeGraphSchemaTool('catalog', catalogConfig(), mockSqliteStore());
    const result = await tool.invoke({ includeExamples: false }) as string;
    assert.ok(!result.includes('Example:'));
  });

  it('should show configured mapping from YAML (direct mapping)', async () => {
    const tool = createKnowledgeGraphSchemaTool('catalog', catalogConfig(), mockSqliteStore());
    const result = await tool.invoke({}) as string;
    assert.ok(result.includes('CONFIGURED MAPPING (from YAML)'));
    assert.ok(result.includes('Entity: Product'));
    assert.ok(result.includes('Entity: Category'));
    assert.ok(result.includes('Entity: Brand'));
    assert.ok(result.includes('Relationship: (Product) -[BELONGS_TO]-> (Category)'));
    assert.ok(result.includes('Relationship: (Product) -[MADE_BY]-> (Brand)'));
  });

  it('should handle empty graph gracefully', async () => {
    const tool = createKnowledgeGraphSchemaTool('catalog', catalogConfig(), mockSqliteStore([], []));
    const result = await tool.invoke({}) as string;
    assert.ok(result.includes('0 entities, 0 relationships'));
    // Should still show configured mapping section
    assert.ok(result.includes('CONFIGURED MAPPING'));
  });

  it('should handle store errors gracefully', async () => {
    const store = {
      getAllEntities: () => { throw new Error('Database corrupted'); },
      getAllRelationships: () => [],
    } as any;
    const tool = createKnowledgeGraphSchemaTool('catalog', catalogConfig(), store);
    const result = await tool.invoke({}) as string;
    assert.ok(result.includes('Schema discovery error'));
    assert.ok(result.includes('Database corrupted'));
  });

  it('should handle entities with invalid JSON properties', async () => {
    const badEntities: EntityRow[] = [{
      id: 'product::bad',
      type: 'Product',
      name: 'Bad Product',
      description: 'Has invalid JSON props',
      properties: 'not-json',
      source_chunk_ids: '[]',
    }];
    const tool = createKnowledgeGraphSchemaTool('catalog', catalogConfig(), mockSqliteStore(badEntities, []));
    const result = await tool.invoke({}) as string;
    // Should not crash, just skip property discovery for that entity
    assert.ok(result.includes('Product (1 entities)'));
  });

  it('should work without directMapping in config', async () => {
    const config = {
      name: 'plain',
      description: 'No mapping configured',
      graph: {},
    } as any;
    const tool = createKnowledgeGraphSchemaTool('plain', config, mockSqliteStore());
    const result = await tool.invoke({}) as string;
    assert.ok(result.includes('GRAPH SCHEMA for "plain"'));
    assert.ok(!result.includes('CONFIGURED MAPPING'));
  });
});
