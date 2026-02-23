import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { CronTriggerHandler } from '../../lib/triggers/cron-trigger.ts';

describe('CronTriggerHandler', () => {
  const trigger = { type: 'cron' as const, schedule: '*/5 * * * *', input: { greeting: 'hello' } };

  const mockOrchestrator = {
    runAgent: async (_name: string, input: Record<string, unknown>) => ({
      output: `result for ${JSON.stringify(input)}`,
      metadata: { duration: 10 },
    }),
    integrations: {
      getChannelContext: () => '',
      getChannelMembers: () => [],
      postMessage: () => {},
    },
  } as any;

  let handler: CronTriggerHandler;

  beforeEach(() => {
    handler = new CronTriggerHandler('test-agent', trigger, mockOrchestrator);
  });

  it('should construct with agent name and trigger', () => {
    assert.ok(handler);
  });

  it('should start scheduling and create a task', () => {
    handler.start();
    // The cron task is created internally; we can verify by calling stop without error
    handler.stop();
  });

  it('should stop without error even if not started', () => {
    handler.stop(); // no-op, should not throw
  });

  it('should stop an active task', () => {
    handler.start();
    handler.stop();
    // Calling stop again should be safe
    handler.stop();
  });
});
