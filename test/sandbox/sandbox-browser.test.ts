import { describe, it, before, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import type { SandboxConfig } from '../../lib/sandbox/types.ts';
import type { StructuredTool } from '../../lib/types/llm-types.ts';

function createConfig(overrides?: Partial<SandboxConfig>): SandboxConfig {
  return {
    enabled: true,
    commandTimeout: 30_000,
    maxOutputChars: 50_000,
    browserCdpUrl: 'http://localhost:9222',
    ...overrides,
  };
}

// Shared mock state that instance methods delegate to
const mockState = {
  connected: true,
  connectFn: async () => {},
  closeFn: async () => {},
  sendFn: async (_method: string, _params?: unknown): Promise<any> => ({}),
  attachFn: async () => {},
  detachFn: () => {},
  observeFn: async () => ({
    url: 'https://example.com',
    title: 'Example',
    readyState: 'complete',
    inflightRequests: 0,
    elements: '- link "Home" [ref=e0]\n- button "Submit" [ref=e1]',
    headings: ['Example Domain'],
    summary: 'Example page',
    textExcerpt: 'This is an example page.',
  }),
  resetForNavigationFn: () => {},
  resetNetworkFlagFn: () => {},
  waitForReadyFn: async () => {},
  waitForSettleFn: async () => {},
  hadNetworkActivityFn: () => false,
  resolveRefFn: (ref: string) => {
    if (ref === 'e0') return 'a[href="/"]';
    if (ref === 'e1') return 'button.submit';
    if (ref === 'e5') return 'input#name';
    throw new Error(`Unknown ref: ${ref}`);
  },
};

function resetMockState() {
  mockState.connected = true;
  mockState.sendFn = async () => ({});
  mockState.observeFn = async () => ({
    url: 'https://example.com',
    title: 'Example',
    readyState: 'complete',
    inflightRequests: 0,
    elements: '- link "Home" [ref=e0]\n- button "Submit" [ref=e1]',
    headings: ['Example Domain'],
    summary: 'Example page',
    textExcerpt: 'This is an example page.',
  });
  mockState.hadNetworkActivityFn = () => false;
  mockState.resetForNavigationFn = () => {};
  mockState.resetNetworkFlagFn = () => {};
  mockState.waitForReadyFn = async () => {};
  mockState.waitForSettleFn = async () => {};
}

// Register mocks before any imports
mock.module('../../lib/sandbox/cdp-client.ts', {
  namedExports: {
    CDPClient: class MockCDPClient {
      get connected() { return mockState.connected; }
      connect(...args: any[]) { return mockState.connectFn(...args); }
      close(...args: any[]) { return mockState.closeFn(...args); }
      send(method: string, params?: unknown) { return mockState.sendFn(method, params); }
      on() {}
    },
  },
});

mock.module('../../lib/sandbox/page-readiness.ts', {
  namedExports: {
    PageReadiness: class MockPageReadiness {
      attach() { return mockState.attachFn(); }
      detach() { return mockState.detachFn(); }
      observe() { return mockState.observeFn(); }
      resetForNavigation() { return mockState.resetForNavigationFn(); }
      resetNetworkFlag() { return mockState.resetNetworkFlagFn(); }
      waitForReady(...args: any[]) { return mockState.waitForReadyFn(...args); }
      waitForSettle(...args: any[]) { return mockState.waitForSettleFn(...args); }
      hadNetworkActivity() { return mockState.hadNetworkActivityFn(); }
      resolveRef(ref: string) { return mockState.resolveRefFn(ref); }
    },
  },
});

// Import after mocking
const { createBrowserTools } = await import('../../lib/sandbox/sandbox-browser.ts');

describe('createBrowserTools', () => {
  function freshTools(configOverrides?: Partial<SandboxConfig>): StructuredTool[] {
    resetMockState();
    return createBrowserTools(createConfig(configOverrides));
  }

  function findTool(tools: StructuredTool[], name: string): StructuredTool {
    const t = tools.find(t => t.name === name);
    assert.ok(t, `Tool "${name}" not found`);
    return t;
  }

  describe('tool creation', () => {
    it('should create 7 browser tools', () => {
      const tools = freshTools();
      assert.equal(tools.length, 7);
    });

    it('should include all expected tool names', () => {
      const tools = freshTools();
      const names = tools.map(t => t.name);
      assert.ok(names.includes('sandbox_browser_observe'));
      assert.ok(names.includes('sandbox_browser_navigate'));
      assert.ok(names.includes('sandbox_browser_screenshot'));
      assert.ok(names.includes('sandbox_browser_content'));
      assert.ok(names.includes('sandbox_browser_evaluate'));
      assert.ok(names.includes('sandbox_browser_click'));
      assert.ok(names.includes('sandbox_browser_type'));
    });

    it('each tool should have a description', () => {
      const tools = freshTools();
      for (const t of tools) {
        assert.ok(t.description.length > 0, `Tool "${t.name}" has no description`);
      }
    });
  });

  describe('sandbox_browser_observe', () => {
    it('should return page snapshot as JSON', async () => {
      const tools = freshTools();
      const observe = findTool(tools, 'sandbox_browser_observe');
      const result = await observe.invoke({});
      const parsed = JSON.parse(result as string);
      assert.equal(parsed.url, 'https://example.com');
      assert.equal(parsed.title, 'Example');
      assert.ok(parsed.textExcerpt.includes('example page'));
    });

    it('should return error JSON when observe throws', async () => {
      const tools = freshTools();
      mockState.observeFn = async () => { throw new Error('CDP disconnected'); };
      const observe = findTool(tools, 'sandbox_browser_observe');
      const result = await observe.invoke({});
      const parsed = JSON.parse(result as string);
      assert.ok(parsed.error.includes('CDP disconnected'));
    });

    it('should return error JSON for non-Error throw', async () => {
      const tools = freshTools();
      mockState.observeFn = async () => { throw 'string error'; };
      const observe = findTool(tools, 'sandbox_browser_observe');
      const result = await observe.invoke({});
      const parsed = JSON.parse(result as string);
      assert.ok(parsed.error.includes('string error'));
    });
  });

  describe('sandbox_browser_navigate', () => {
    it('should navigate and return snapshot', async () => {
      const tools = freshTools();
      mockState.sendFn = async (method: string) => {
        if (method === 'Page.navigate') return {};
        return {};
      };
      const navigate = findTool(tools, 'sandbox_browser_navigate');
      const result = await navigate.invoke({ url: 'https://example.com' });
      const parsed = JSON.parse(result as string);
      assert.equal(parsed.url, 'https://example.com');
      assert.equal(parsed.title, 'Example');
    });

    it('should return error when navigation has errorText', async () => {
      const tools = freshTools();
      mockState.sendFn = async (method: string) => {
        if (method === 'Page.navigate') return { errorText: 'net::ERR_NAME_NOT_RESOLVED' };
        return {};
      };
      const navigate = findTool(tools, 'sandbox_browser_navigate');
      const result = await navigate.invoke({ url: 'https://invalid.test' });
      const parsed = JSON.parse(result as string);
      assert.ok(parsed.error.includes('net::ERR_NAME_NOT_RESOLVED'));
    });

    it('should call resetForNavigation and waitForReady', async () => {
      const tools = freshTools();
      let resetCalled = false;
      let waitReadyCalled = false;
      mockState.sendFn = async () => ({});
      mockState.resetForNavigationFn = () => { resetCalled = true; };
      mockState.waitForReadyFn = async () => { waitReadyCalled = true; };
      const navigate = findTool(tools, 'sandbox_browser_navigate');
      await navigate.invoke({ url: 'https://example.com' });
      assert.ok(resetCalled);
      assert.ok(waitReadyCalled);
    });

    it('should return error JSON when navigate throws', async () => {
      const tools = freshTools();
      mockState.sendFn = async () => { throw new Error('Connection refused'); };
      const navigate = findTool(tools, 'sandbox_browser_navigate');
      const result = await navigate.invoke({ url: 'https://example.com' });
      const parsed = JSON.parse(result as string);
      assert.ok(parsed.error.includes('Connection refused'));
    });
  });

  describe('sandbox_browser_screenshot', () => {
    it('should return ContentPart array with image data', async () => {
      const tools = freshTools();
      mockState.sendFn = async () => ({ data: 'base64imagedata' });
      const screenshot = findTool(tools, 'sandbox_browser_screenshot');
      const result = await screenshot.invoke({});
      assert.ok(Array.isArray(result));
      const parts = result as any[];
      assert.equal(parts[0].type, 'image');
      assert.equal(parts[0].data, 'base64imagedata');
      assert.equal(parts[0].mediaType, 'image/jpeg');
      assert.equal(parts[1].type, 'text');
      assert.ok(parts[1].text.includes('Screenshot captured'));
    });

    it('should return error string when screenshot fails', async () => {
      const tools = freshTools();
      mockState.sendFn = async () => { throw new Error('Screenshot failed'); };
      const screenshot = findTool(tools, 'sandbox_browser_screenshot');
      const result = await screenshot.invoke({});
      const parsed = JSON.parse(result as string);
      assert.ok(parsed.error.includes('Screenshot failed'));
    });
  });

  describe('sandbox_browser_content', () => {
    it('should return full page content as markdown', async () => {
      const tools = freshTools();
      mockState.sendFn = async () => ({
        result: { value: '<html><body><h1>Hello</h1><p>World</p></body></html>' },
      });
      const content = findTool(tools, 'sandbox_browser_content');
      const result = await content.invoke({});
      const parsed = JSON.parse(result as string);
      assert.ok(parsed.content);
      assert.equal(parsed.selector, null);
    });

    it('should return content for a specific selector', async () => {
      const tools = freshTools();
      mockState.sendFn = async () => ({
        result: { value: '<div><p>Selected content</p></div>' },
      });
      const content = findTool(tools, 'sandbox_browser_content');
      const result = await content.invoke({ selector: 'div.main' });
      const parsed = JSON.parse(result as string);
      assert.ok(parsed.content);
      assert.equal(parsed.selector, 'div.main');
    });

    it('should return error when element not found with selector', async () => {
      const tools = freshTools();
      mockState.sendFn = async () => ({ result: { value: null } });
      const content = findTool(tools, 'sandbox_browser_content');
      const result = await content.invoke({ selector: 'div.nonexistent' });
      const parsed = JSON.parse(result as string);
      assert.ok(parsed.error.includes('Element not found'));
    });

    it('should return error when no content at all (no selector)', async () => {
      const tools = freshTools();
      mockState.sendFn = async () => ({ result: { value: null } });
      const content = findTool(tools, 'sandbox_browser_content');
      const result = await content.invoke({});
      const parsed = JSON.parse(result as string);
      assert.ok(parsed.error.includes('No content'));
    });

    it('should truncate content exceeding maxOutputChars', async () => {
      const longHtml = '<html><body>' + '<p>' + 'x'.repeat(20_000) + '</p></body></html>';
      const tools = freshTools({ maxOutputChars: 1000 });
      mockState.sendFn = async () => ({ result: { value: longHtml } });
      const content = findTool(tools, 'sandbox_browser_content');
      const result = await content.invoke({});
      const parsed = JSON.parse(result as string);
      assert.equal(parsed.truncated, true);
    });

    it('should return error JSON when content throws', async () => {
      const tools = freshTools();
      mockState.sendFn = async () => { throw new Error('Evaluation failed'); };
      const content = findTool(tools, 'sandbox_browser_content');
      const result = await content.invoke({});
      const parsed = JSON.parse(result as string);
      assert.ok(parsed.error.includes('Evaluation failed'));
    });
  });

  describe('sandbox_browser_evaluate', () => {
    it('should evaluate JS and return result', async () => {
      const tools = freshTools();
      mockState.sendFn = async (method: string, params?: any) => {
        if (method === 'Runtime.evaluate' && params?.expression === 'location.href') {
          return { result: { value: 'https://example.com', type: 'string' } };
        }
        return { result: { value: 42, type: 'number' } };
      };
      const evaluate = findTool(tools, 'sandbox_browser_evaluate');
      const result = await evaluate.invoke({ expression: '1 + 1' });
      const parsed = JSON.parse(result as string);
      assert.equal(parsed.result, 42);
      assert.equal(parsed.type, 'number');
    });

    it('should report URL change side effect', async () => {
      const tools = freshTools();
      let urlCallCount = 0;
      mockState.sendFn = async (method: string, params?: any) => {
        if (method === 'Runtime.evaluate' && params?.expression === 'location.href') {
          urlCallCount++;
          if (urlCallCount <= 1) return { result: { value: 'https://example.com/a' } };
          return { result: { value: 'https://example.com/b' } };
        }
        return { result: { value: undefined, type: 'undefined' } };
      };
      const evaluate = findTool(tools, 'sandbox_browser_evaluate');
      const result = await evaluate.invoke({ expression: 'window.location.href = "/b"' });
      const parsed = JSON.parse(result as string);
      assert.ok(parsed.sideEffects?.urlChanged);
      assert.equal(parsed.sideEffects.urlChanged.from, 'https://example.com/a');
      assert.equal(parsed.sideEffects.urlChanged.to, 'https://example.com/b');
    });

    it('should report network activity side effect', async () => {
      const tools = freshTools();
      mockState.sendFn = async (method: string, params?: any) => {
        if (method === 'Runtime.evaluate' && params?.expression === 'location.href') {
          return { result: { value: 'https://example.com' } };
        }
        return { result: { value: 'ok', type: 'string' } };
      };
      mockState.hadNetworkActivityFn = () => true;
      const evaluate = findTool(tools, 'sandbox_browser_evaluate');
      const result = await evaluate.invoke({ expression: 'fetch("/api")' });
      const parsed = JSON.parse(result as string);
      assert.equal(parsed.sideEffects?.networkTriggered, true);
    });

    it('should not include sideEffects when none occurred', async () => {
      const tools = freshTools();
      mockState.sendFn = async (method: string, params?: any) => {
        if (method === 'Runtime.evaluate' && params?.expression === 'location.href') {
          return { result: { value: 'https://example.com' } };
        }
        return { result: { value: 42, type: 'number' } };
      };
      mockState.hadNetworkActivityFn = () => false;
      const evaluate = findTool(tools, 'sandbox_browser_evaluate');
      const result = await evaluate.invoke({ expression: '21 * 2' });
      const parsed = JSON.parse(result as string);
      assert.equal(parsed.sideEffects, undefined);
    });

    it('should return error for evaluation exceptions (subtype error)', async () => {
      const tools = freshTools();
      mockState.sendFn = async (method: string, params?: any) => {
        if (method === 'Runtime.evaluate' && params?.expression === 'location.href') {
          return { result: { value: 'https://example.com' } };
        }
        return {
          result: { subtype: 'error', description: 'ReferenceError: foo is not defined' },
          exceptionDetails: { exception: { description: 'ReferenceError: foo is not defined' } },
        };
      };
      const evaluate = findTool(tools, 'sandbox_browser_evaluate');
      const result = await evaluate.invoke({ expression: 'foo' });
      const parsed = JSON.parse(result as string);
      assert.ok(parsed.error.includes('ReferenceError'));
    });

    it('should return error for exceptionDetails without subtype', async () => {
      const tools = freshTools();
      mockState.sendFn = async (method: string, params?: any) => {
        if (method === 'Runtime.evaluate' && params?.expression === 'location.href') {
          return { result: { value: 'https://example.com' } };
        }
        return {
          result: { type: 'object' },
          exceptionDetails: { exception: { description: 'TypeError: oops' } },
        };
      };
      const evaluate = findTool(tools, 'sandbox_browser_evaluate');
      const result = await evaluate.invoke({ expression: 'null.foo' });
      const parsed = JSON.parse(result as string);
      assert.ok(parsed.error.includes('TypeError'));
    });

    it('should return null result for undefined value', async () => {
      const tools = freshTools();
      mockState.sendFn = async (method: string, params?: any) => {
        if (method === 'Runtime.evaluate' && params?.expression === 'location.href') {
          return { result: { value: 'https://example.com' } };
        }
        return { result: { type: 'undefined' } };
      };
      const evaluate = findTool(tools, 'sandbox_browser_evaluate');
      const result = await evaluate.invoke({ expression: 'void 0' });
      const parsed = JSON.parse(result as string);
      assert.equal(parsed.result, null);
      assert.equal(parsed.type, 'undefined');
    });

    it('should return error JSON when evaluate throws', async () => {
      const tools = freshTools();
      mockState.sendFn = async () => { throw new Error('Runtime crashed'); };
      const evaluate = findTool(tools, 'sandbox_browser_evaluate');
      const result = await evaluate.invoke({ expression: '1+1' });
      const parsed = JSON.parse(result as string);
      assert.ok(parsed.error.includes('Runtime crashed'));
    });
  });

  describe('sandbox_browser_click', () => {
    it('should click by ref and return result', async () => {
      const tools = freshTools();
      mockState.sendFn = async (method: string, params?: any) => {
        if (method === 'Runtime.evaluate') {
          const expr = params?.expression as string;
          if (expr === 'location.href') return { result: { value: 'https://example.com' } };
          if (expr === 'document.title') return { result: { value: 'Example' } };
          if (expr.includes('document.querySelector') && expr.includes('found')) {
            return { result: { value: { found: true, tag: 'a', text: 'Home' } } };
          }
          return { result: { value: true } };
        }
        return {};
      };
      const click = findTool(tools, 'sandbox_browser_click');
      const result = await click.invoke({ ref: 'e0' });
      const parsed = JSON.parse(result as string);
      assert.ok(parsed.clicked);
      assert.equal(parsed.navigated, false);
      assert.equal(parsed.url, 'https://example.com');
      assert.equal(parsed.title, 'Example');
    });

    it('should click by text and return result', async () => {
      const tools = freshTools();
      mockState.sendFn = async (method: string, params?: any) => {
        if (method === 'Runtime.evaluate') {
          const expr = params?.expression as string;
          if (expr === 'location.href') return { result: { value: 'https://example.com' } };
          if (expr === 'document.title') return { result: { value: 'Example' } };
          if (expr.includes('searchText') && expr.includes('found')) {
            return { result: { value: { found: true, tag: 'button', text: 'Submit' } } };
          }
          return { result: { value: true } };
        }
        return {};
      };
      const click = findTool(tools, 'sandbox_browser_click');
      const result = await click.invoke({ text: 'Submit' });
      const parsed = JSON.parse(result as string);
      assert.ok(parsed.clicked);
    });

    it('should return error when element not found', async () => {
      const tools = freshTools();
      mockState.sendFn = async (_method: string, params?: any) => {
        const expr = params?.expression as string;
        if (expr && expr.includes('found')) {
          return { result: { value: { error: 'No clickable element found containing text: Nonexistent' } } };
        }
        return { result: { value: 'https://example.com' } };
      };
      const click = findTool(tools, 'sandbox_browser_click');
      const result = await click.invoke({ text: 'Nonexistent' });
      const parsed = JSON.parse(result as string);
      assert.ok(parsed.error);
    });

    it('should detect navigation after click', async () => {
      const tools = freshTools();
      let urlCallCount = 0;
      mockState.sendFn = async (method: string, params?: any) => {
        if (method === 'Runtime.evaluate') {
          const expr = params?.expression as string;
          if (expr === 'location.href') {
            urlCallCount++;
            if (urlCallCount <= 1) return { result: { value: 'https://example.com/a' } };
            return { result: { value: 'https://example.com/b' } };
          }
          if (expr === 'document.title') return { result: { value: 'Page B' } };
          if (expr.includes('found')) return { result: { value: { found: true, tag: 'a', text: 'Link' } } };
          return { result: { value: true } };
        }
        return {};
      };
      const click = findTool(tools, 'sandbox_browser_click');
      const result = await click.invoke({ ref: 'e0' });
      const parsed = JSON.parse(result as string);
      assert.equal(parsed.navigated, true);
      assert.equal(parsed.url, 'https://example.com/b');
    });

    it('should return error JSON when click throws', async () => {
      const tools = freshTools();
      mockState.sendFn = async () => { throw new Error('Click failed'); };
      const click = findTool(tools, 'sandbox_browser_click');
      const result = await click.invoke({ ref: 'e0' });
      const parsed = JSON.parse(result as string);
      assert.ok(parsed.error.includes('Click failed'));
    });
  });

  describe('sandbox_browser_type', () => {
    it('should type text into an input by ref', async () => {
      const tools = freshTools();
      mockState.sendFn = async () => ({
        result: { value: { typed: true, value: 'hello world' } },
      });
      const type_ = findTool(tools, 'sandbox_browser_type');
      const result = await type_.invoke({ ref: 'e5', text: 'hello world' });
      const parsed = JSON.parse(result as string);
      assert.equal(parsed.typed, true);
      assert.equal(parsed.value, 'hello world');
    });

    it('should return error when element not found', async () => {
      const tools = freshTools();
      mockState.sendFn = async () => ({
        result: { value: { error: 'Element not found: e5' } },
      });
      const type_ = findTool(tools, 'sandbox_browser_type');
      const result = await type_.invoke({ ref: 'e5', text: 'test' });
      const parsed = JSON.parse(result as string);
      assert.ok(parsed.error.includes('Element not found'));
    });

    it('should return error when element is not an input', async () => {
      const tools = freshTools();
      mockState.sendFn = async () => ({
        result: { value: { error: 'Element is not an input: DIV' } },
      });
      const type_ = findTool(tools, 'sandbox_browser_type');
      const result = await type_.invoke({ ref: 'e5', text: 'test' });
      const parsed = JSON.parse(result as string);
      assert.ok(parsed.error.includes('not an input'));
    });

    it('should return error JSON when type throws', async () => {
      const tools = freshTools();
      mockState.sendFn = async () => { throw new Error('Type failed'); };
      const type_ = findTool(tools, 'sandbox_browser_type');
      const result = await type_.invoke({ ref: 'e5', text: 'test' });
      const parsed = JSON.parse(result as string);
      assert.ok(parsed.error.includes('Type failed'));
    });

    it('should call waitForSettle after typing', async () => {
      const tools = freshTools();
      let settleCalled = false;
      mockState.waitForSettleFn = async () => { settleCalled = true; };
      mockState.sendFn = async () => ({
        result: { value: { typed: true, value: 'hi' } },
      });
      const type_ = findTool(tools, 'sandbox_browser_type');
      await type_.invoke({ ref: 'e5', text: 'hi' });
      assert.ok(settleCalled);
    });
  });

  describe('connection management', () => {
    it('should clean up old connection and reconnect when disconnected', async () => {
      const tools = freshTools();
      let connectCount = 0;
      let closeCount = 0;
      let detachCount = 0;
      mockState.connectFn = async () => { connectCount++; };
      mockState.closeFn = async () => { closeCount++; };
      mockState.detachFn = () => { detachCount++; };
      // Start disconnected, so it needs to connect
      mockState.connected = false;
      const observe = findTool(tools, 'sandbox_browser_observe');
      await observe.invoke({});
      assert.equal(connectCount, 1);
    });
  });
});
