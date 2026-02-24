import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createKnowledgeEntityLookupTool } from '../../lib/tools/built-in/knowledge-entity-lookup.tool.ts';
import type { EntityRow } from '../../lib/knowledge/sqlite-store.ts';

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
    properties: JSON.stringify({ slug: 'peripherals', productCount: 2 }),
    source_chunk_ids: '[]',
  },
  {
    id: 'category::20',
    type: 'Category',
    name: 'Monitors',
    description: 'Display monitors and screens',
    properties: JSON.stringify({ slug: 'monitors', productCount: 1 }),
    source_chunk_ids: '[]',
  },
  {
    id: 'brand::100',
    type: 'Brand',
    name: 'KeyTech',
    description: 'Premium keyboard manufacturer',
    properties: JSON.stringify({ country: 'Japan', founded: 2015 }),
    source_chunk_ids: '[]',
  },
];

function catalogConfig() {
  return {
    name: 'catalog',
    description: 'Product catalog with categories and brands',
    graph: {
      directMapping: {
        entities: [
          { type: 'Product', idColumn: 'id', nameColumn: 'name', properties: ['sku', 'price', 'inStock'] },
          { type: 'Category', idColumn: 'category_id', nameColumn: 'category_name', properties: ['slug'] },
          { type: 'Brand', idColumn: 'brand_id', nameColumn: 'brand_name', properties: ['country'] },
        ],
        relationships: [
          { type: 'BELONGS_TO', source: 'Product', target: 'Category' },
          { type: 'MADE_BY', source: 'Product', target: 'Brand' },
        ],
      },
    },
  } as any;
}

function mockSqliteStore(overrides: Record<string, any> = {}) {
  return {
    getEntity: (id: string) => ENTITIES.find(e => e.id === id),
    getAllEntities: () => ENTITIES,
    getAllRelationships: () => [],
    getEntityCount: () => ENTITIES.length,
    ...overrides,
  } as any;
}

describe('createKnowledgeEntityLookupTool', () => {
  it('should create a tool with correct name and schema info in description', () => {
    const tool = createKnowledgeEntityLookupTool('catalog', catalogConfig(), mockSqliteStore());
    assert.equal(tool.name, 'knowledge_entity_lookup_catalog');
    assert.ok(tool.description.includes('catalog'));
    assert.ok(tool.description.includes('Product'));
    assert.ok(tool.description.includes('BELONGS_TO'));
  });

  it('should lookup entity by exact ID', async () => {
    const tool = createKnowledgeEntityLookupTool('catalog', catalogConfig(), mockSqliteStore());
    const result = await tool.invoke({ id: 'product::1' }) as string;
    assert.ok(result.includes('Ergonomic Wireless Keyboard'));
    assert.ok(result.includes('[Product]'));
    assert.ok(result.includes('ID: product::1'));
    assert.ok(result.includes('sku'));
    assert.ok(result.includes('KB-ERG-001'));
  });

  it('should return not-found for unknown ID', async () => {
    const tool = createKnowledgeEntityLookupTool('catalog', catalogConfig(), mockSqliteStore());
    const result = await tool.invoke({ id: 'product::999' }) as string;
    assert.ok(result.includes('No entity found'));
    assert.ok(result.includes('product::999'));
  });

  it('should search by name (case-insensitive partial match)', async () => {
    const tool = createKnowledgeEntityLookupTool('catalog', catalogConfig(), mockSqliteStore());
    const result = await tool.invoke({ name: 'keyboard' }) as string;
    assert.ok(result.includes('Ergonomic Wireless Keyboard'));
    assert.ok(!result.includes('Curved Monitor'));
    assert.ok(!result.includes('Peripherals'));
  });

  it('should filter by entity type', async () => {
    const tool = createKnowledgeEntityLookupTool('catalog', catalogConfig(), mockSqliteStore());
    const result = await tool.invoke({ type: 'category' }) as string;
    assert.ok(result.includes('Peripherals'));
    assert.ok(result.includes('Monitors'));
    assert.ok(!result.includes('Ergonomic'));
    assert.ok(!result.includes('KeyTech'));
    assert.ok(result.includes('Found 2'));
  });

  it('should combine name and type filters', async () => {
    const tool = createKnowledgeEntityLookupTool('catalog', catalogConfig(), mockSqliteStore());
    const result = await tool.invoke({ name: 'key', type: 'brand' }) as string;
    assert.ok(result.includes('KeyTech'));
    assert.ok(result.includes('Found 1'));
    assert.ok(!result.includes('Keyboard')); // "key" in name but type=Brand filters it
  });

  it('should also match by ID substring in name search', async () => {
    const tool = createKnowledgeEntityLookupTool('catalog', catalogConfig(), mockSqliteStore());
    const result = await tool.invoke({ name: 'brand::100' }) as string;
    assert.ok(result.includes('KeyTech'));
  });

  it('should return no-match message with filter criteria', async () => {
    const tool = createKnowledgeEntityLookupTool('catalog', catalogConfig(), mockSqliteStore());
    const result = await tool.invoke({ name: 'laptop', type: 'product' }) as string;
    assert.ok(result.includes('No entities found'));
    assert.ok(result.includes('name="laptop"'));
    assert.ok(result.includes('type="product"'));
  });

  it('should respect limit parameter', async () => {
    const tool = createKnowledgeEntityLookupTool('catalog', catalogConfig(), mockSqliteStore());
    const result = await tool.invoke({ type: 'product', limit: 2 }) as string;
    assert.ok(result.includes('Found 3'));
    assert.ok(result.includes('showing 2'));
  });

  it('should display entity properties excluding internal fields', async () => {
    const tool = createKnowledgeEntityLookupTool('catalog', catalogConfig(), mockSqliteStore());
    const result = await tool.invoke({ id: 'product::1' }) as string;
    assert.ok(result.includes('sku'));
    assert.ok(result.includes('price'));
    assert.ok(!result.includes('sourceChunkIds'));
    assert.ok(!result.includes('embedding'));
  });

  it('should display entity description', async () => {
    const tool = createKnowledgeEntityLookupTool('catalog', catalogConfig(), mockSqliteStore());
    const result = await tool.invoke({ id: 'brand::100' }) as string;
    assert.ok(result.includes('Description: Premium keyboard manufacturer'));
  });

  it('should handle lookup errors gracefully', async () => {
    const store = mockSqliteStore({
      getEntity: () => { throw new Error('SQLite busy'); },
    });
    const tool = createKnowledgeEntityLookupTool('catalog', catalogConfig(), store);
    const result = await tool.invoke({ id: 'product::1' }) as string;
    assert.ok(result.includes('Lookup error'));
    assert.ok(result.includes('SQLite busy'));
  });

  it('should handle search errors gracefully', async () => {
    const store = mockSqliteStore({
      getAllEntities: () => { throw new Error('Table locked'); },
    });
    const tool = createKnowledgeEntityLookupTool('catalog', catalogConfig(), store);
    const result = await tool.invoke({ name: 'keyboard' }) as string;
    assert.ok(result.includes('Lookup error'));
  });

  it('should list all entities when no filters given', async () => {
    const tool = createKnowledgeEntityLookupTool('catalog', catalogConfig(), mockSqliteStore());
    const result = await tool.invoke({}) as string;
    assert.ok(result.includes('Found 6'));
    assert.ok(result.includes('Ergonomic'));
    assert.ok(result.includes('Peripherals'));
    assert.ok(result.includes('KeyTech'));
  });
});
