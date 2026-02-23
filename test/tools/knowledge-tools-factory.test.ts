import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createKnowledgeTools, buildGraphSchemaDescription } from '../../lib/tools/built-in/knowledge-tools-factory.ts';

// --- Realistic mock data: e-commerce product catalog ---

function mockSqliteStore(entityCount: number = 0) {
  return {
    getEntityCount: () => entityCount,
    getAllEntities: () => [],
    getAllRelationships: () => [],
    getEntity: () => undefined,
    getNeighborhood: () => ({ entities: [], relationships: [] }),
  } as any;
}

describe('createKnowledgeTools', () => {
  it('should create only search tool for a file-based store without graph', () => {
    const store = {
      config: {
        name: 'product-docs',
        description: 'Product documentation',
        source: { type: 'file', path: 'docs/products.md' },
      },
      search: async () => [],
    } as any;

    const tools = createKnowledgeTools('product-docs', store);
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.name, 'knowledge_search_product-docs');
  });

  it('should create search + graph tools when sqliteStore has entities', () => {
    const store = {
      config: {
        name: 'catalog',
        description: 'Product catalog with categories',
        source: { type: 'database', connectionString: 'postgresql://localhost/shop', query: 'SELECT * FROM products' },
        graph: {
          directMapping: {
            entities: [
              { type: 'Product', idColumn: 'id', nameColumn: 'name', properties: ['price', 'sku'] },
              { type: 'Category', idColumn: 'category_id', nameColumn: 'category_name', properties: ['description'] },
            ],
            relationships: [
              { type: 'BELONGS_TO', source: 'Product', target: 'Category', sourceIdColumn: 'id', targetIdColumn: 'category_id' },
            ],
          },
        },
      },
      search: async () => [],
    } as any;

    const tools = createKnowledgeTools('catalog', store, mockSqliteStore(50));
    const toolNames = tools.map(t => t.name);

    assert.ok(toolNames.includes('knowledge_search_catalog'));
    assert.ok(toolNames.includes('knowledge_traverse_catalog'));
    assert.ok(toolNames.includes('knowledge_entity_lookup_catalog'));
    assert.ok(toolNames.includes('knowledge_graph_schema_catalog'));
    // database source also gets sql tool
    assert.ok(toolNames.includes('knowledge_sql_catalog'));
    assert.equal(tools.length, 5);
  });

  it('should NOT create graph tools when sqliteStore has zero entities', () => {
    const store = {
      config: {
        name: 'empty-graph',
        description: 'Empty knowledge base',
        source: { type: 'file', path: 'data.csv' },
        graph: { directMapping: { entities: [], relationships: [] } },
      },
      search: async () => [],
    } as any;

    const tools = createKnowledgeTools('empty-graph', store, mockSqliteStore(0));
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.name, 'knowledge_search_empty-graph');
  });

  it('should create search + sql tools for database source without graph', () => {
    const store = {
      config: {
        name: 'orders-db',
        description: 'Order history database',
        source: {
          type: 'database',
          connectionString: 'postgresql://localhost/shop',
          query: 'SELECT id, customer_name, total, status FROM orders',
          contentColumn: 'customer_name',
          metadataColumns: ['id', 'total', 'status'],
        },
      },
      search: async () => [],
    } as any;

    const tools = createKnowledgeTools('orders-db', store);
    const toolNames = tools.map(t => t.name);

    assert.equal(tools.length, 2);
    assert.ok(toolNames.includes('knowledge_search_orders-db'));
    assert.ok(toolNames.includes('knowledge_sql_orders-db'));
  });

  it('should create graph tools without sql when source is not database', () => {
    const store = {
      config: {
        name: 'csv-catalog',
        description: 'Catalog from CSV',
        source: { type: 'file', path: 'catalog.csv' },
        graph: {
          directMapping: {
            entities: [{ type: 'Product', idColumn: 'sku', nameColumn: 'name', properties: ['price'] }],
          },
        },
      },
      search: async () => [],
    } as any;

    const tools = createKnowledgeTools('csv-catalog', store, mockSqliteStore(10));
    const toolNames = tools.map(t => t.name);

    assert.equal(tools.length, 4); // search + 3 graph tools, no sql
    assert.ok(toolNames.includes('knowledge_search_csv-catalog'));
    assert.ok(toolNames.includes('knowledge_traverse_csv-catalog'));
    assert.ok(toolNames.includes('knowledge_entity_lookup_csv-catalog'));
    assert.ok(toolNames.includes('knowledge_graph_schema_csv-catalog'));
    assert.ok(!toolNames.includes('knowledge_sql_csv-catalog'));
  });
});

describe('buildGraphSchemaDescription', () => {
  it('should build description from direct mapping config', () => {
    const config = {
      name: 'catalog',
      description: 'Product catalog with categories and brands',
      graph: {
        directMapping: {
          entities: [
            { type: 'Product', idColumn: 'id', nameColumn: 'name', properties: ['price', 'sku'] },
            { type: 'Category', idColumn: 'category_id', nameColumn: 'category_name', properties: ['description'] },
          ],
          relationships: [
            { source: 'Product', target: 'Category', type: 'BELONGS_TO' },
          ],
        },
      },
    } as any;

    const desc = buildGraphSchemaDescription(config);
    assert.ok(desc.includes('catalog'));
    assert.ok(desc.includes('Product catalog'));
    assert.ok(desc.includes('Product'));
    assert.ok(desc.includes('Category'));
    assert.ok(desc.includes('price'));
    assert.ok(desc.includes('sku'));
    assert.ok(desc.includes('BELONGS_TO'));
    assert.ok(desc.includes('(Product) -[BELONGS_TO]-> (Category)'));
  });

  it('should handle config without graph', () => {
    const config = { name: 'plain-docs', description: 'Just documents' } as any;
    const desc = buildGraphSchemaDescription(config);
    assert.ok(desc.includes('plain-docs'));
    assert.ok(desc.includes('Just documents'));
  });

  it('should handle config with empty directMapping', () => {
    const config = {
      name: 'empty',
      description: 'Empty graph',
      graph: { directMapping: { entities: [], relationships: [] } },
    } as any;

    const desc = buildGraphSchemaDescription(config);
    assert.ok(desc.includes('empty'));
  });

  it('should handle entities with mapped property syntax', () => {
    const config = {
      name: 'mapped',
      description: 'Has mapped properties',
      graph: {
        directMapping: {
          entities: [
            {
              type: 'Employee',
              idColumn: 'emp_id',
              nameColumn: 'full_name',
              properties: [
                'department',
                { title: 'job_title' },
              ],
            },
          ],
        },
      },
    } as any;

    const desc = buildGraphSchemaDescription(config);
    assert.ok(desc.includes('Employee'));
    assert.ok(desc.includes('department'));
    assert.ok(desc.includes('job_title'));
  });
});
