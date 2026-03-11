import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { WebLoader } from '../../lib/knowledge/loaders/web-loader.ts';
import type { WebSourceConfig } from '../../lib/knowledge/types.ts';

// Mock fetch helper
function mockFetch(status: number, body: string, contentType = 'text/html') {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url: string | URL | Request, _opts?: RequestInit) => {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : status === 404 ? 'Not Found' : 'Error',
      text: async () => body,
      headers: new Headers({ 'content-type': contentType }),
    } as Response;
  };
  return () => { globalThis.fetch = original; };
}

describe('WebLoader', () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    if (restore) { restore(); restore = undefined; }
  });

  // --- HTML loader ---

  it('should load HTML and extract body text', async () => {
    restore = mockFetch(200, '<html><body><h1>Title</h1><p>Content here</p></body></html>');
    const config: WebSourceConfig = { type: 'web', url: 'https://example.com' };
    const loader = new WebLoader(config, 'html');
    const docs = await loader.load();

    assert.equal(docs.length, 1);
    assert.ok(docs[0]!.pageContent.includes('Title'));
    assert.ok(docs[0]!.pageContent.includes('Content here'));
    assert.equal(docs[0]!.metadata.source, 'https://example.com');
  });

  it('should strip script and style tags from HTML', async () => {
    restore = mockFetch(200, '<html><body><script>alert(1)</script><style>.x{}</style><p>Clean</p></body></html>');
    const config: WebSourceConfig = { type: 'web', url: 'https://example.com' };
    const loader = new WebLoader(config, 'html');
    const docs = await loader.load();

    assert.equal(docs.length, 1);
    assert.ok(!docs[0]!.pageContent.includes('alert'));
    assert.ok(!docs[0]!.pageContent.includes('.x'));
    assert.ok(docs[0]!.pageContent.includes('Clean'));
  });

  it('should use CSS selector when provided', async () => {
    restore = mockFetch(200, '<html><body><div id="nav">Nav</div><div class="content">Main text</div></body></html>');
    const config: WebSourceConfig = { type: 'web', url: 'https://example.com', selector: '.content' };
    const loader = new WebLoader(config, 'html');
    const docs = await loader.load();

    assert.equal(docs.length, 1);
    assert.ok(docs[0]!.pageContent.includes('Main text'));
    assert.ok(!docs[0]!.pageContent.includes('Nav'));
  });

  it('should return empty for HTML with no text content', async () => {
    restore = mockFetch(200, '<html><body><script>var x=1;</script></body></html>');
    const config: WebSourceConfig = { type: 'web', url: 'https://example.com' };
    const loader = new WebLoader(config, 'html');
    const docs = await loader.load();

    assert.equal(docs.length, 0);
  });

  it('should default to html loader type', async () => {
    restore = mockFetch(200, '<html><body><p>Default</p></body></html>');
    const config: WebSourceConfig = { type: 'web', url: 'https://example.com' };
    const loader = new WebLoader(config);
    const docs = await loader.load();

    assert.equal(docs.length, 1);
    assert.ok(docs[0]!.pageContent.includes('Default'));
  });

  // --- Text / Markdown loader ---

  it('should load raw text content', async () => {
    restore = mockFetch(200, 'Plain text content');
    const config: WebSourceConfig = { type: 'web', url: 'https://example.com/file.txt' };
    const loader = new WebLoader(config, 'text');
    const docs = await loader.load();

    assert.equal(docs.length, 1);
    assert.equal(docs[0]!.pageContent, 'Plain text content');
  });

  it('should load markdown content', async () => {
    restore = mockFetch(200, '# Heading\n\nParagraph text');
    const config: WebSourceConfig = { type: 'web', url: 'https://example.com/doc.md' };
    const loader = new WebLoader(config, 'markdown');
    const docs = await loader.load();

    assert.equal(docs.length, 1);
    assert.equal(docs[0]!.pageContent, '# Heading\n\nParagraph text');
  });

  it('should return empty for blank text content', async () => {
    restore = mockFetch(200, '   \n  ');
    const config: WebSourceConfig = { type: 'web', url: 'https://example.com' };
    const loader = new WebLoader(config, 'text');
    const docs = await loader.load();

    assert.equal(docs.length, 0);
  });

  // --- JSON loader ---

  it('should load JSON array of objects', async () => {
    restore = mockFetch(200, JSON.stringify([{ name: 'Alice' }, { name: 'Bob' }]));
    const config: WebSourceConfig = { type: 'web', url: 'https://api.example.com/users' };
    const loader = new WebLoader(config, 'json');
    const docs = await loader.load();

    assert.equal(docs.length, 2);
    assert.ok(docs[0]!.pageContent.includes('name: Alice'));
    assert.ok(docs[1]!.pageContent.includes('name: Bob'));
  });

  it('should extract nested JSON via jsonPath', async () => {
    const payload = { data: { results: [{ title: 'A' }, { title: 'B' }] } };
    restore = mockFetch(200, JSON.stringify(payload));
    const config: WebSourceConfig = { type: 'web', url: 'https://api.example.com', jsonPath: 'data.results' };
    const loader = new WebLoader(config, 'json');
    const docs = await loader.load();

    assert.equal(docs.length, 2);
    assert.ok(docs[0]!.pageContent.includes('title: A'));
  });

  it('should throw on invalid jsonPath', async () => {
    restore = mockFetch(200, JSON.stringify({ items: [] }));
    const config: WebSourceConfig = { type: 'web', url: 'https://api.example.com', jsonPath: 'nonexistent.path' };
    const loader = new WebLoader(config, 'json');

    await assert.rejects(() => loader.load(), /jsonPath.*not found/);
  });

  // --- CSV loader ---

  it('should load CSV content', async () => {
    restore = mockFetch(200, 'name,age\nAlice,30\nBob,25');
    const config: WebSourceConfig = { type: 'web', url: 'https://example.com/data.csv' };
    const loader = new WebLoader(config, 'csv');
    const docs = await loader.load();

    assert.equal(docs.length, 2);
    assert.ok(docs[0]!.pageContent.includes('name: Alice'));
  });

  // --- Error handling ---

  it('should throw on HTTP 404', async () => {
    restore = mockFetch(404, 'Not Found');
    const config: WebSourceConfig = { type: 'web', url: 'https://example.com/missing' };
    const loader = new WebLoader(config, 'html');

    await assert.rejects(() => loader.load(), /404/);
  });

  it('should throw on HTTP 500', async () => {
    restore = mockFetch(500, 'Internal Server Error');
    const config: WebSourceConfig = { type: 'web', url: 'https://example.com/broken' };
    const loader = new WebLoader(config, 'html');

    await assert.rejects(() => loader.load(), /HTTP 500/);
  });

  it('should throw on network errors', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('ENOTFOUND'); };
    restore = () => { globalThis.fetch = original; };

    const config: WebSourceConfig = { type: 'web', url: 'https://nonexistent.example.com' };
    const loader = new WebLoader(config, 'html');

    await assert.rejects(() => loader.load(), /Network error/);
  });

  it('should pass custom headers to fetch', async () => {
    let capturedHeaders: HeadersInit | undefined;
    const original = globalThis.fetch;
    globalThis.fetch = async (_url: string | URL | Request, opts?: RequestInit) => {
      capturedHeaders = opts?.headers;
      return { ok: true, status: 200, statusText: 'OK', text: async () => '<p>ok</p>' } as Response;
    };
    restore = () => { globalThis.fetch = original; };

    const config: WebSourceConfig = {
      type: 'web',
      url: 'https://api.example.com',
      headers: { 'Authorization': 'Bearer token123' },
    };
    const loader = new WebLoader(config, 'html');
    await loader.load();

    assert.deepEqual(capturedHeaders, { 'Authorization': 'Bearer token123' });
  });
});
