import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { TriggerManager } from '../../lib/triggers/trigger-manager.ts';

describe('TriggerManager', () => {
  let manager: TriggerManager;

  beforeEach(() => {
    manager = new TriggerManager();
  });

  it('should start with zero handlers', () => {
    assert.equal(manager.cronCount, 0);
    assert.equal(manager.webhookCount, 0);
  });

  it('should handle agents with no triggers', async () => {
    const mockOrchestrator = {
      agents: { list: () => [{ name: 'a1', triggers: [] }] },
    } as any;

    const mockFastify = { post: () => {} } as any;

    await manager.start(mockOrchestrator, mockFastify);

    assert.equal(manager.cronCount, 0);
    assert.equal(manager.webhookCount, 0);
  });

  it('should register webhook triggers', async () => {
    const mockOrchestrator = {
      agents: {
        list: () => [{
          name: 'webhook-agent',
          triggers: [{ type: 'webhook', path: '/hook/test', input: {} }],
        }],
      },
      runAgent: async () => ({ output: 'result', metadata: { duration: 0 } }),
    } as any;

    const registeredRoutes: string[] = [];
    const mockFastify = {
      post: (path: string) => { registeredRoutes.push(path); },
    } as any;

    await manager.start(mockOrchestrator, mockFastify);

    assert.equal(manager.webhookCount, 1);
    assert.ok(registeredRoutes.includes('/hook/test'));
  });

  it('should detect webhook path collisions', async () => {
    const mockOrchestrator = {
      agents: {
        list: () => [
          { name: 'a1', triggers: [{ type: 'webhook', path: '/hook/same', input: {} }] },
          { name: 'a2', triggers: [{ type: 'webhook', path: '/hook/same', input: {} }] },
        ],
      },
    } as any;

    const mockFastify = { post: () => {} } as any;

    await manager.start(mockOrchestrator, mockFastify);

    // Only one should be registered (collision detected for second)
    assert.equal(manager.webhookCount, 1);
  });

  it('should close all handlers', async () => {
    const mockOrchestrator = {
      agents: {
        list: () => [{
          name: 'a1',
          triggers: [{ type: 'webhook', path: '/hook/a1', input: {} }],
        }],
      },
    } as any;

    const mockFastify = { post: () => {} } as any;

    await manager.start(mockOrchestrator, mockFastify);
    assert.equal(manager.webhookCount, 1);

    manager.close();
    assert.equal(manager.cronCount, 0);
    assert.equal(manager.webhookCount, 0);
  });

  it('should register cron triggers', async () => {
    const mockOrchestrator = {
      agents: {
        list: () => [{
          name: 'cron-agent',
          triggers: [{ type: 'cron', schedule: '*/5 * * * *', input: { greeting: 'hello' } }],
        }],
      },
      integrations: {
        getChannelContext: () => '',
        getChannelMembers: () => [],
        postMessage: () => {},
      },
      runAgent: async () => ({ output: 'done', metadata: { duration: 10 } }),
    } as any;

    const mockFastify = { post: () => {} } as any;

    await manager.start(mockOrchestrator, mockFastify);
    assert.equal(manager.cronCount, 1);

    // Close should stop cron handlers
    manager.close();
    assert.equal(manager.cronCount, 0);
  });
});
