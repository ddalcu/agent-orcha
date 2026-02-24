import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import { createSandboxWebFetchTool, createSandboxWebSearchTool } from '../../lib/sandbox/sandbox-web.ts';
import type { SandboxConfig } from '../../lib/sandbox/types.ts';

const defaultConfig: SandboxConfig = {
  enabled: true,
  commandTimeout: 30_000,
  maxOutputChars: 50_000,
};

// Helper to mock global fetch
function mockFetch(handler: (url: string | URL | Request, init?: RequestInit) => Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = handler as typeof globalThis.fetch;
  return () => { globalThis.fetch = original; };
}

function makeResponse(body: string, opts: { status?: number; contentType?: string } = {}): Response {
  const headers = new Headers();
  if (opts.contentType) headers.set('content-type', opts.contentType);
  return new Response(body, {
    status: opts.status ?? 200,
    headers,
  });
}

describe('createSandboxWebFetchTool - invoke handlers', () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it('should fetch HTML and convert to markdown', async () => {
    restore = mockFetch(async () =>
      makeResponse('<html><body><h1>Hello</h1><p>World</p></body></html>', { contentType: 'text/html' })
    );
    const tool = createSandboxWebFetchTool(defaultConfig);
    const result = JSON.parse(await tool.invoke({ url: 'https://example.com', runScripts: false }) as string);
    assert.equal(result.status, 200);
    assert.ok(result.content.includes('Hello'));
    assert.ok(result.content.includes('World'));
    assert.equal(result.truncated, false);
  });

  it('should return raw content when raw=true', async () => {
    const html = '<html><body><p>Raw content</p></body></html>';
    restore = mockFetch(async () => makeResponse(html, { contentType: 'text/html' }));
    const tool = createSandboxWebFetchTool(defaultConfig);
    const result = JSON.parse(await tool.invoke({ url: 'https://example.com', raw: true }) as string);
    assert.equal(result.content, html);
    assert.equal(result.truncated, false);
  });

  it('should return raw content for non-HTML content types', async () => {
    const json = '{"key": "value"}';
    restore = mockFetch(async () => makeResponse(json, { contentType: 'application/json' }));
    const tool = createSandboxWebFetchTool(defaultConfig);
    const result = JSON.parse(await tool.invoke({ url: 'https://example.com', runScripts: false }) as string);
    assert.equal(result.content, json);
  });

  it('should truncate content exceeding maxOutputChars', async () => {
    const longContent = 'x'.repeat(100);
    restore = mockFetch(async () => makeResponse(longContent, { contentType: 'application/json' }));
    const tool = createSandboxWebFetchTool({ ...defaultConfig, maxOutputChars: 50 });
    const result = JSON.parse(await tool.invoke({ url: 'https://example.com', runScripts: false }) as string);
    assert.equal(result.content.length, 50);
    assert.equal(result.truncated, true);
  });

  it('should truncate raw HTML content exceeding maxOutputChars', async () => {
    const longHtml = 'y'.repeat(200);
    restore = mockFetch(async () => makeResponse(longHtml, { contentType: 'text/html' }));
    const tool = createSandboxWebFetchTool({ ...defaultConfig, maxOutputChars: 80 });
    const result = JSON.parse(await tool.invoke({ url: 'https://example.com', raw: true }) as string);
    assert.equal(result.content.length, 80);
    assert.equal(result.truncated, true);
  });

  it('should return error on fetch failure', async () => {
    restore = mockFetch(async () => { throw new Error('Network error'); });
    const tool = createSandboxWebFetchTool(defaultConfig);
    const result = JSON.parse(await tool.invoke({ url: 'https://example.com' }) as string);
    assert.ok(result.error.includes('Network error'));
  });

  it('should truncate markdown content exceeding maxOutputChars', async () => {
    const bigBody = `<html><body><p>${'a'.repeat(200)}</p></body></html>`;
    restore = mockFetch(async () => makeResponse(bigBody, { contentType: 'text/html' }));
    const tool = createSandboxWebFetchTool({ ...defaultConfig, maxOutputChars: 50 });
    const result = JSON.parse(await tool.invoke({ url: 'https://example.com', runScripts: false }) as string);
    assert.equal(result.truncated, true);
    assert.ok(result.content.length <= 50);
  });
});

describe('createSandboxWebSearchTool - invoke handlers', () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  const SEARCH_HTML = `
    <html><body>
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage1&rut=abc">Result One</a>
      <a class="result__snippet" href="#">Snippet for result one</a>
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage2&rut=def">Result &amp; Two</a>
      <a class="result__snippet" href="#">Snippet for &lt;result&gt; two</a>
    </body></html>
  `;

  it('should parse search results from DuckDuckGo HTML', async () => {
    restore = mockFetch(async () => makeResponse(SEARCH_HTML, { contentType: 'text/html' }));
    const tool = createSandboxWebSearchTool();
    const result = JSON.parse(await tool.invoke({ query: 'test query' }) as string);
    assert.ok(result.results.includes('Result One'));
    assert.ok(result.results.includes('example.com/page1'));
    assert.ok(result.results.includes('Snippet for result one'));
  });

  it('should decode HTML entities in results', async () => {
    restore = mockFetch(async () => makeResponse(SEARCH_HTML, { contentType: 'text/html' }));
    const tool = createSandboxWebSearchTool();
    const result = JSON.parse(await tool.invoke({ query: 'test' }) as string);
    // &amp; should be decoded to &
    assert.ok(result.results.includes('Result & Two'));
    // &lt; and &gt; should be decoded
    assert.ok(result.results.includes('<result>'));
  });

  it('should resolve uddg URLs', async () => {
    restore = mockFetch(async () => makeResponse(SEARCH_HTML, { contentType: 'text/html' }));
    const tool = createSandboxWebSearchTool();
    const result = JSON.parse(await tool.invoke({ query: 'test' }) as string);
    assert.ok(result.results.includes('https://example.com/page2'));
  });

  it('should return error for non-200 response', async () => {
    restore = mockFetch(async () => makeResponse('error', { status: 503 }));
    const tool = createSandboxWebSearchTool();
    const result = JSON.parse(await tool.invoke({ query: 'test' }) as string);
    assert.ok(result.error.includes('503'));
  });

  it('should detect CAPTCHA/blocked pages', async () => {
    const blockedHtml = '<html><body>blocked</body></html>';
    restore = mockFetch(async () => makeResponse(blockedHtml, { contentType: 'text/html' }));
    const tool = createSandboxWebSearchTool();
    const result = JSON.parse(await tool.invoke({ query: 'test' }) as string);
    assert.ok(result.error.includes('blocked') || result.error.includes('Search blocked'));
  });

  it('should return no results message when HTML has no matches', async () => {
    restore = mockFetch(async () => makeResponse('<html><body>Nothing here</body></html>', { contentType: 'text/html' }));
    const tool = createSandboxWebSearchTool();
    const result = JSON.parse(await tool.invoke({ query: 'test' }) as string);
    assert.ok(result.results.includes('No results'));
  });

  it('should return error on fetch failure', async () => {
    restore = mockFetch(async () => { throw new Error('Timeout'); });
    const tool = createSandboxWebSearchTool();
    const result = JSON.parse(await tool.invoke({ query: 'test' }) as string);
    assert.ok(result.error.includes('Timeout'));
  });

  it('should respect num_results limit', async () => {
    restore = mockFetch(async () => makeResponse(SEARCH_HTML, { contentType: 'text/html' }));
    const tool = createSandboxWebSearchTool();
    const result = JSON.parse(await tool.invoke({ query: 'test', num_results: 1 }) as string);
    // Should only have 1 numbered result
    assert.ok(result.results.includes('1.'));
    assert.ok(!result.results.includes('2.'));
  });
});
