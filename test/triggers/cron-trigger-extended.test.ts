import { describe, it, mock } from 'node:test';
import { strict as assert } from 'node:assert';

// Shared mock state
const cronState = {
  callbacks: new Map<string, () => Promise<void>>(),
  stopFn: mock.fn(),
};

function resetCronState() {
  cronState.callbacks.clear();
  cronState.stopFn = mock.fn();
}

mock.module('node-cron', {
  defaultExport: {
    schedule: (schedule: string, callback: () => Promise<void>) => {
      cronState.callbacks.set(schedule, callback);
      return { stop: cronState.stopFn };
    },
  },
});

mock.module('../../lib/logger.ts', {
  namedExports: {
    createLogger: () => ({
      info: () => {},
      error: () => {},
      warn: () => {},
      debug: () => {},
    }),
  },
});

const { CronTriggerHandler } = await import('../../lib/triggers/cron-trigger.ts');

const baseTrigger = { type: 'cron' as const, schedule: '*/5 * * * *', input: { greeting: 'hello' } };

function createMockOrchestrator(overrides?: Record<string, any>) {
  return {
    runAgent: mock.fn(async () => ({
      output: 'agent result',
      metadata: { duration: 10 },
    })),
    integrations: {
      getChannelContext: mock.fn(() => ''),
      getChannelMembers: mock.fn(() => []),
      postMessage: mock.fn(() => {}),
    },
    ...overrides,
  } as any;
}

describe('CronTriggerHandler — extended', () => {
  it('should construct with agent name, trigger, and orchestrator', () => {
    resetCronState();
    const orch = createMockOrchestrator();
    const handler = new CronTriggerHandler('test-agent', baseTrigger, orch);
    assert.ok(handler);
    assert.equal(handler.agentName, 'test-agent');
  });

  it('should schedule a cron job on start()', () => {
    resetCronState();
    const orch = createMockOrchestrator();
    const handler = new CronTriggerHandler('test-agent', baseTrigger, orch);
    handler.start();
    assert.ok(cronState.callbacks.has('*/5 * * * *'));
  });

  it('should stop the cron task on stop()', () => {
    resetCronState();
    const orch = createMockOrchestrator();
    const handler = new CronTriggerHandler('test-agent', baseTrigger, orch);
    handler.start();
    handler.stop();
    assert.equal(cronState.stopFn.mock.callCount(), 1);
  });

  it('should be safe to call stop() without start()', () => {
    resetCronState();
    const orch = createMockOrchestrator();
    const handler = new CronTriggerHandler('test-agent', baseTrigger, orch);
    handler.stop(); // should not throw
  });

  it('should be safe to call stop() multiple times', () => {
    resetCronState();
    const orch = createMockOrchestrator();
    const handler = new CronTriggerHandler('test-agent', baseTrigger, orch);
    handler.start();
    handler.stop();
    handler.stop(); // second call is a no-op
    assert.equal(cronState.stopFn.mock.callCount(), 1);
  });

  it('should run agent with trigger input when cron fires', async () => {
    resetCronState();
    const orch = createMockOrchestrator();
    const handler = new CronTriggerHandler('test-agent', baseTrigger, orch);
    handler.start();

    const callback = cronState.callbacks.get('*/5 * * * *');
    assert.ok(callback);
    await callback();

    assert.equal(orch.runAgent.mock.callCount(), 1);
    const [agentName, input, sessionId] = orch.runAgent.mock.calls[0].arguments;
    assert.equal(agentName, 'test-agent');
    assert.deepEqual(input, { greeting: 'hello' });
    assert.equal(sessionId, 'trigger-test-agent-cron');
  });

  it('should include channel context when available', async () => {
    resetCronState();
    const orch = createMockOrchestrator();
    orch.integrations.getChannelContext = mock.fn(() => 'some channel context');
    const handler = new CronTriggerHandler('test-agent', baseTrigger, orch);
    handler.start();

    const callback = cronState.callbacks.get('*/5 * * * *');
    assert.ok(callback);
    await callback();

    const [, input] = orch.runAgent.mock.calls[0].arguments;
    assert.equal(input.channelContext, 'some channel context');
  });

  it('should include channel members when available', async () => {
    resetCronState();
    const orch = createMockOrchestrator();
    orch.integrations.getChannelMembers = mock.fn(() => [
      { name: 'Alice' },
      { name: 'Bob' },
    ]);
    const handler = new CronTriggerHandler('test-agent', baseTrigger, orch);
    handler.start();

    const callback = cronState.callbacks.get('*/5 * * * *');
    assert.ok(callback);
    await callback();

    const [, input] = orch.runAgent.mock.calls[0].arguments;
    assert.equal(input.channelMembers, 'Alice, Bob');
  });

  it('should post agent output message after run', async () => {
    resetCronState();
    const orch = createMockOrchestrator();
    const handler = new CronTriggerHandler('test-agent', baseTrigger, orch);
    handler.start();

    const callback = cronState.callbacks.get('*/5 * * * *');
    assert.ok(callback);
    await callback();

    assert.equal(orch.integrations.postMessage.mock.callCount(), 1);
    const [agentName, message] = orch.integrations.postMessage.mock.calls[0].arguments;
    assert.equal(agentName, 'test-agent');
    assert.equal(message, 'agent result');
  });

  it('should JSON-stringify non-string output', async () => {
    resetCronState();
    const orch = createMockOrchestrator();
    orch.runAgent = mock.fn(async () => ({
      output: { key: 'value' },
      metadata: { duration: 10 },
    }));
    const handler = new CronTriggerHandler('test-agent', baseTrigger, orch);
    handler.start();

    const callback = cronState.callbacks.get('*/5 * * * *');
    assert.ok(callback);
    await callback();

    const [, message] = orch.integrations.postMessage.mock.calls[0].arguments;
    assert.equal(message, JSON.stringify({ key: 'value' }));
  });

  it('should handle agent execution errors gracefully', async () => {
    resetCronState();
    const orch = createMockOrchestrator();
    orch.runAgent = mock.fn(async () => {
      throw new Error('Agent execution failed');
    });
    const handler = new CronTriggerHandler('test-agent', baseTrigger, orch);
    handler.start();

    const callback = cronState.callbacks.get('*/5 * * * *');
    assert.ok(callback);
    // Should not throw
    await callback();
    // postMessage should NOT be called since the agent errored
    assert.equal(orch.integrations.postMessage.mock.callCount(), 0);
  });

  it('should not set channelContext when empty string', async () => {
    resetCronState();
    const orch = createMockOrchestrator();
    orch.integrations.getChannelContext = mock.fn(() => '');
    orch.integrations.getChannelMembers = mock.fn(() => []);
    const handler = new CronTriggerHandler('test-agent', baseTrigger, orch);
    handler.start();

    const callback = cronState.callbacks.get('*/5 * * * *');
    assert.ok(callback);
    await callback();

    const [, input] = orch.runAgent.mock.calls[0].arguments;
    assert.equal(input.channelContext, undefined);
    assert.equal(input.channelMembers, undefined);
    assert.equal(input.greeting, 'hello');
  });

  it('should work with empty trigger input', async () => {
    resetCronState();
    const emptyTrigger = { type: 'cron' as const, schedule: '0 * * * *', input: {} };
    const orch = createMockOrchestrator();
    const handler = new CronTriggerHandler('test-agent', emptyTrigger, orch);
    handler.start();

    const callback = cronState.callbacks.get('0 * * * *');
    assert.ok(callback);
    await callback();

    const [, input] = orch.runAgent.mock.calls[0].arguments;
    assert.deepEqual(input, {});
  });

  it('should not mutate original trigger input', async () => {
    resetCronState();
    const trigger = { type: 'cron' as const, schedule: '*/10 * * * *', input: { key: 'val' } };
    const orch = createMockOrchestrator();
    orch.integrations.getChannelContext = mock.fn(() => 'ctx');
    const handler = new CronTriggerHandler('test-agent', trigger, orch);
    handler.start();

    const callback = cronState.callbacks.get('*/10 * * * *');
    assert.ok(callback);
    await callback();

    // Original trigger input should still only have 'key'
    assert.deepEqual(trigger.input, { key: 'val' });
  });
});
