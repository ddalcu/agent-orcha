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

  it('should remove cron triggers for a specific agent', async () => {
    const mockOrchestrator = {
      agents: {
        list: () => [
          {
            name: 'cron-a',
            triggers: [{ type: 'cron', schedule: '*/5 * * * *', input: {} }],
          },
          {
            name: 'cron-b',
            triggers: [{ type: 'cron', schedule: '*/10 * * * *', input: {} }],
          },
        ],
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
    assert.equal(manager.cronCount, 2);

    manager.removeAgentTriggers('cron-a');
    assert.equal(manager.cronCount, 1);

    // Removing again should be a no-op
    manager.removeAgentTriggers('cron-a');
    assert.equal(manager.cronCount, 1);

    manager.close();
  });

  it('should remove webhook triggers for a specific agent', async () => {
    const mockOrchestrator = {
      agents: {
        list: () => [
          { name: 'wh-a', triggers: [{ type: 'webhook', path: '/hook/a', input: {} }] },
          { name: 'wh-b', triggers: [{ type: 'webhook', path: '/hook/b', input: {} }] },
        ],
      },
    } as any;

    const mockFastify = { post: () => {} } as any;

    await manager.start(mockOrchestrator, mockFastify);
    assert.equal(manager.webhookCount, 2);

    manager.removeAgentTriggers('wh-a');
    assert.equal(manager.webhookCount, 1);

    manager.close();
  });

  it('should not affect other agents when removing triggers', async () => {
    const mockOrchestrator = {
      agents: {
        list: () => [
          { name: 'keep-me', triggers: [{ type: 'webhook', path: '/hook/keep', input: {} }] },
          { name: 'remove-me', triggers: [{ type: 'webhook', path: '/hook/remove', input: {} }] },
        ],
      },
    } as any;

    const mockFastify = { post: () => {} } as any;

    await manager.start(mockOrchestrator, mockFastify);
    assert.equal(manager.webhookCount, 2);

    manager.removeAgentTriggers('remove-me');
    assert.equal(manager.webhookCount, 1);

    // Removing a non-existent agent should be safe
    manager.removeAgentTriggers('nonexistent');
    assert.equal(manager.webhookCount, 1);

    manager.close();
  });
});
