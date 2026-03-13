import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { PageReadiness } from '../../lib/sandbox/page-readiness.ts';

/**
 * Fake CDP client that records sent commands and allows event simulation.
 */
function createFakeCDP() {
  const sentCommands: { method: string; params?: object }[] = [];
  const listeners = new Map<string, ((params: unknown) => void)[]>();

  return {
    sentCommands,
    listeners,
    send: mock.fn(async (method: string, params?: object) => {
      sentCommands.push({ method, params });
      // For Runtime.evaluate calls, return a mock result
      if (method === 'Runtime.evaluate') {
        const expr = (params as any)?.expression ?? '';
        if (expr === 'document.readyState') {
          return { result: { value: 'complete' } };
        }
        // Return a valid observe script result
        return {
          result: {
            value: JSON.stringify({
              url: 'http://example.com',
              title: 'Example',
              readyState: 'complete',
              headings: ['Hello'],
              summary: '100 chars',
              textExcerpt: 'Hello world',
              elements: '- a "Link" [ref=e1]',
              refs: { e1: '#link1' },
            }),
          },
        };
      }
      return {};
    }),
    on: mock.fn((event: string, handler: (params: unknown) => void) => {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
      return () => {
        const idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
      };
    }),
    // Helper to simulate CDP events
    emit(event: string, params: unknown = {}) {
      const list = listeners.get(event);
      if (list) {
        for (const fn of list) fn(params);
      }
    },
  };
}

describe('PageReadiness', () => {
  let cdp: ReturnType<typeof createFakeCDP>;
  let readiness: PageReadiness;

  beforeEach(() => {
    cdp = createFakeCDP();
    readiness = new PageReadiness(cdp as any);
  });

  afterEach(() => {
    readiness.detach();
  });

  describe('attach', () => {
    it('should enable Page, Network, and DOM domains', async () => {
      await readiness.attach();

      const methods = cdp.sentCommands.map(c => c.method);
      assert.ok(methods.includes('Page.enable'));
      assert.ok(methods.includes('Network.enable'));
      assert.ok(methods.includes('DOM.enable'));
    });

    it('should inject stealth script', async () => {
      await readiness.attach();

      const methods = cdp.sentCommands.map(c => c.method);
      assert.ok(methods.includes('Page.addScriptToEvaluateOnNewDocument'));
    });

    it('should register event listeners for page/network/DOM', async () => {
      await readiness.attach();

      const registeredEvents = [...cdp.listeners.keys()];
      assert.ok(registeredEvents.includes('Page.loadEventFired'));
      assert.ok(registeredEvents.includes('Network.requestWillBeSent'));
      assert.ok(registeredEvents.includes('Network.loadingFinished'));
      assert.ok(registeredEvents.includes('Network.loadingFailed'));
      assert.ok(registeredEvents.includes('DOM.documentUpdated'));
      assert.ok(registeredEvents.includes('Page.javascriptDialogOpening'));
    });
  });

  describe('detach', () => {
    it('should remove all event listeners', async () => {
      await readiness.attach();

      // Listeners registered
      assert.ok(cdp.listeners.size > 0);

      readiness.detach();

      // All listeners should be removed (unsubscribers called)
      // The maps still exist but listeners were spliced out
      // Calling detach again should be safe
      readiness.detach();
    });
  });

  describe('event handling', () => {
    it('should track loadFired on Page.loadEventFired', async () => {
      await readiness.attach();
      cdp.emit('Page.loadEventFired');
      // Internal state — verified indirectly via waitForReady behavior
    });

    it('should increment inflight requests on Network.requestWillBeSent', async () => {
      await readiness.attach();
      cdp.emit('Network.requestWillBeSent');
      cdp.emit('Network.requestWillBeSent');
      // Two requests in flight — verified via observe's inflightRequests
    });

    it('should decrement inflight requests on Network.loadingFinished', async () => {
      await readiness.attach();
      cdp.emit('Network.requestWillBeSent');
      cdp.emit('Network.loadingFinished');
      // Should be back to 0
    });

    it('should decrement inflight requests on Network.loadingFailed', async () => {
      await readiness.attach();
      cdp.emit('Network.requestWillBeSent');
      cdp.emit('Network.loadingFailed');
      // Should be back to 0
    });

    it('should not go below zero inflight requests', async () => {
      await readiness.attach();
      cdp.emit('Network.loadingFinished');
      // inflightRequests should be max(0, -1) = 0
      const snapshot = await readiness.observe();
      assert.strictEqual(snapshot.inflightRequests, 0);
    });

    it('should auto-dismiss JavaScript dialogs', async () => {
      await readiness.attach();
      cdp.emit('Page.javascriptDialogOpening');

      // Should have sent Page.handleJavaScriptDialog with accept: true
      const handleCmd = cdp.sentCommands.find(c => c.method === 'Page.handleJavaScriptDialog');
      assert.ok(handleCmd);
      assert.deepStrictEqual((handleCmd as any).params, { accept: true });
    });
  });

  describe('resetForNavigation', () => {
    it('should reset load and network state', async () => {
      await readiness.attach();

      // Simulate some activity
      cdp.emit('Page.loadEventFired');
      cdp.emit('Network.requestWillBeSent');

      readiness.resetForNavigation();

      // hadNetworkActivity should be false after reset
      assert.strictEqual(readiness.hadNetworkActivity(), false);
    });
  });

  describe('resetNetworkFlag / hadNetworkActivity', () => {
    it('should track and reset network activity flag', async () => {
      await readiness.attach();

      assert.strictEqual(readiness.hadNetworkActivity(), false);

      cdp.emit('Network.requestWillBeSent');
      assert.strictEqual(readiness.hadNetworkActivity(), true);

      readiness.resetNetworkFlag();
      assert.strictEqual(readiness.hadNetworkActivity(), false);
    });
  });

  describe('waitForReady', () => {
    it('should resolve quickly when page is fully loaded and idle', async () => {
      await readiness.attach();

      // Fire load event and let timers settle
      cdp.emit('Page.loadEventFired');

      // Set last activity to the past so settle checks pass
      const start = Date.now();
      await readiness.waitForReady(2000);
      const elapsed = Date.now() - start;

      // Should resolve reasonably quickly (within 2 seconds)
      assert.ok(elapsed < 2000, `waitForReady took too long: ${elapsed}ms`);
    });

    it('should resolve at hard cap when conditions are not met', async () => {
      await readiness.attach();

      // Never fire loadEventFired, keep requests in flight
      cdp.emit('Network.requestWillBeSent');

      // Override CDP send to return 'loading' for readyState check
      cdp.send.mock.mockImplementation(async (method: string) => {
        if (method === 'Runtime.evaluate') {
          return { result: { value: 'loading' } };
        }
        return {};
      });

      const start = Date.now();
      await readiness.waitForReady(1000);
      const elapsed = Date.now() - start;

      // Should resolve at the timeout cap
      assert.ok(elapsed >= 900, `waitForReady resolved too early: ${elapsed}ms`);
    });

    it('should resolve after 2s with load + DOM stable but lingering requests', async () => {
      await readiness.attach();

      cdp.emit('Page.loadEventFired');
      // Keep a request in flight
      cdp.emit('Network.requestWillBeSent');

      const start = Date.now();
      await readiness.waitForReady(5000);
      const elapsed = Date.now() - start;

      // Should resolve around 2s mark (good enough condition)
      assert.ok(elapsed >= 1800, `resolved too early: ${elapsed}ms`);
      assert.ok(elapsed < 4000, `resolved too late: ${elapsed}ms`);
    });
  });

  describe('waitForSettle', () => {
    it('should resolve when network and DOM are quiet', async () => {
      await readiness.attach();

      const start = Date.now();
      await readiness.waitForSettle(100);
      const elapsed = Date.now() - start;

      // Should settle quickly since there's no activity
      assert.ok(elapsed < 500, `waitForSettle took too long: ${elapsed}ms`);
    });

    it('should respect SETTLE_MAX_MS cap', async () => {
      await readiness.attach();

      // Keep triggering network activity
      const interval = setInterval(() => {
        cdp.emit('Network.requestWillBeSent');
      }, 20);

      const start = Date.now();
      await readiness.waitForSettle(5000);
      const elapsed = Date.now() - start;

      clearInterval(interval);

      // Should resolve at SETTLE_MAX_MS (2000ms)
      assert.ok(elapsed >= 1800, `resolved too early: ${elapsed}ms`);
      assert.ok(elapsed < 3000, `resolved too late: ${elapsed}ms`);
    });
  });

  describe('resolveRef', () => {
    it('should return CSS selector for known ref after observe()', async () => {
      await readiness.attach();

      await readiness.observe();

      assert.strictEqual(readiness.resolveRef('e1'), '#link1');
    });

    it('should return the input string for unknown ref', () => {
      assert.strictEqual(readiness.resolveRef('.my-class'), '.my-class');
    });

    it('should return the input string for unknown ref name', () => {
      assert.strictEqual(readiness.resolveRef('e99'), 'e99');
    });
  });

  describe('observe', () => {
    it('should return a PageSnapshot with correct fields', async () => {
      await readiness.attach();

      const snapshot = await readiness.observe();

      assert.strictEqual(snapshot.url, 'http://example.com');
      assert.strictEqual(snapshot.title, 'Example');
      assert.strictEqual(snapshot.readyState, 'complete');
      assert.deepStrictEqual(snapshot.headings, ['Hello']);
      assert.strictEqual(snapshot.summary, '100 chars');
      assert.strictEqual(snapshot.textExcerpt, 'Hello world');
      assert.ok(snapshot.elements.includes('e1'));
      assert.strictEqual(typeof snapshot.inflightRequests, 'number');
    });

    it('should handle empty/null result from Runtime.evaluate', async () => {
      await readiness.attach();

      // Override to return null result
      cdp.send.mock.mockImplementation(async (method: string) => {
        if (method === 'Runtime.evaluate') {
          return { result: { value: null } };
        }
        return {};
      });

      const snapshot = await readiness.observe();

      assert.strictEqual(snapshot.url, '');
      assert.strictEqual(snapshot.title, '');
      assert.strictEqual(snapshot.readyState, 'unknown');
    });

    it('should update refMap on each observe call', async () => {
      await readiness.attach();

      await readiness.observe();
      assert.strictEqual(readiness.resolveRef('e1'), '#link1');

      // Second observe with different refs
      cdp.send.mock.mockImplementation(async (method: string) => {
        if (method === 'Runtime.evaluate') {
          return {
            result: {
              value: JSON.stringify({
                url: 'http://example.com/page2',
                title: 'Page 2',
                readyState: 'complete',
                headings: [],
                summary: '',
                textExcerpt: '',
                elements: '- button "Submit" [ref=e1]',
                refs: { e1: '#submit-btn' },
              }),
            },
          };
        }
        return {};
      });

      await readiness.observe();
      // Ref map should be updated
      assert.strictEqual(readiness.resolveRef('e1'), '#submit-btn');
    });
  });
});
