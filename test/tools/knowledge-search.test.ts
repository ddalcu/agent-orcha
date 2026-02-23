import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createKnowledgeSearchTool } from '../../lib/tools/built-in/knowledge-search.tool.ts';
import type { SearchResult } from '../../lib/knowledge/types.ts';

// --- Realistic mock data: e-commerce product catalog ---

const PRODUCT_RESULTS: SearchResult[] = [
  {
    content: 'The Ergonomic Wireless Keyboard features low-profile mechanical switches, ' +
      'Bluetooth 5.0 connectivity, and a rechargeable battery lasting up to 90 days.',
    score: 0.952,
    metadata: { source: 'products.csv', sku: 'KB-ERG-001', category: 'Peripherals' },
  },
  {
    content: 'Ultra-wide 34" curved monitor with 3440x1440 resolution, 144Hz refresh rate, ' +
      'and USB-C hub with 90W power delivery.',
    score: 0.887,
    metadata: { source: 'products.csv', sku: 'MON-UW-034', category: 'Monitors' },
  },
  {
    content: 'Compact mechanical numpad with hot-swappable switches, RGB backlighting, ' +
      'and programmable macro keys.',
    score: 0.743,
    metadata: { source: 'products.csv', sku: 'KB-NUM-002', category: 'Peripherals' },
  },
];

function mockStore(results: SearchResult[] = [], description = 'Product catalog') {
  return {
    config: { description },
    search: async (_query: string, _k?: number) => results,
  } as any;
}

describe('createKnowledgeSearchTool', () => {
  it('should create a tool with correct name and description', () => {
    const tool = createKnowledgeSearchTool('catalog', mockStore());
    assert.equal(tool.name, 'knowledge_search_catalog');
    assert.ok(tool.description.includes('catalog'));
    assert.ok(tool.description.includes('Product catalog'));
  });

  it('should return "no results" message when search yields nothing', async () => {
    const tool = createKnowledgeSearchTool('catalog', mockStore([]));
    const result = await tool.invoke({ query: 'quantum computing accessories' });
    assert.equal(result, 'No relevant documents found.');
  });

  it('should format results with scores and metadata', async () => {
    const tool = createKnowledgeSearchTool('catalog', mockStore(PRODUCT_RESULTS));
    const result = await tool.invoke({ query: 'wireless keyboard with bluetooth' }) as string;

    // First result
    assert.ok(result.includes('[1]'));
    assert.ok(result.includes('0.952'));
    assert.ok(result.includes('sku: KB-ERG-001'));
    assert.ok(result.includes('category: Peripherals'));
    assert.ok(result.includes('Ergonomic Wireless Keyboard'));

    // Second result
    assert.ok(result.includes('[2]'));
    assert.ok(result.includes('0.887'));
    assert.ok(result.includes('MON-UW-034'));

    // Third result
    assert.ok(result.includes('[3]'));
    assert.ok(result.includes('0.743'));
  });

  it('should separate results with dividers', async () => {
    const tool = createKnowledgeSearchTool('catalog', mockStore(PRODUCT_RESULTS));
    const result = await tool.invoke({ query: 'keyboards and monitors' }) as string;
    const dividers = result.split('---').length - 1;
    assert.equal(dividers, 2); // 3 results = 2 dividers
  });

  it('should pass k parameter to store.search', async () => {
    let receivedK: number | undefined;
    const store = {
      config: { description: 'Test' },
      search: async (_q: string, k?: number) => {
        receivedK = k;
        return [];
      },
    } as any;

    const tool = createKnowledgeSearchTool('catalog', store);
    await tool.invoke({ query: 'mechanical keyboards', k: 8 });
    assert.equal(receivedK, 8);
  });

  it('should handle results with empty metadata', async () => {
    const results: SearchResult[] = [
      { content: 'A product with no metadata.', score: 0.5, metadata: {} },
    ];
    const tool = createKnowledgeSearchTool('catalog', mockStore(results));
    const result = await tool.invoke({ query: 'product' }) as string;
    assert.ok(result.includes('A product with no metadata.'));
    assert.ok(result.includes('0.500'));
  });

  it('should handle single result', async () => {
    const results: SearchResult[] = [PRODUCT_RESULTS[0]!];
    const tool = createKnowledgeSearchTool('catalog', mockStore(results));
    const result = await tool.invoke({ query: 'keyboard' }) as string;
    assert.ok(result.includes('Ergonomic'));
    assert.ok(!result.includes('---')); // no divider for single result
  });
});
