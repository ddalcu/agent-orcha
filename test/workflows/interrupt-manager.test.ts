import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { InterruptManager } from '../../lib/workflows/interrupt-manager.ts';
import type { InterruptState } from '../../lib/workflows/types.ts';

describe('InterruptManager', () => {
  let manager: InterruptManager;

  beforeEach(() => {
    manager = new InterruptManager();
  });

  function makeInterrupt(overrides: Partial<InterruptState> = {}): InterruptState {
    return {
      threadId: 'thread-1',
      workflowName: 'test-wf',
      question: 'Continue?',
      timestamp: Date.now(),
      resolved: false,
      ...overrides,
    };
  }

  it('should add and retrieve an interrupt', () => {
    const interrupt = makeInterrupt();
    manager.addInterrupt(interrupt);

    const result = manager.getInterrupt('thread-1');
    assert.ok(result);
    assert.equal(result.threadId, 'thread-1');
    assert.equal(result.question, 'Continue?');
  });

  it('should return undefined for non-existent interrupt', () => {
    assert.equal(manager.getInterrupt('nonexistent'), undefined);
  });

  it('should resolve an interrupt', () => {
    manager.addInterrupt(makeInterrupt());

    const resolved = manager.resolveInterrupt('thread-1', 'yes');
    assert.equal(resolved, true);

    const interrupt = manager.getInterrupt('thread-1');
    assert.ok(interrupt);
    assert.equal(interrupt.resolved, true);
    assert.equal(interrupt.answer, 'yes');
  });

  it('should return false when resolving non-existent interrupt', () => {
    assert.equal(manager.resolveInterrupt('nonexistent', 'yes'), false);
  });

  it('should remove an interrupt', () => {
    manager.addInterrupt(makeInterrupt());

    assert.equal(manager.removeInterrupt('thread-1'), true);
    assert.equal(manager.getInterrupt('thread-1'), undefined);
  });

  it('should return false when removing non-existent interrupt', () => {
    assert.equal(manager.removeInterrupt('nonexistent'), false);
  });

  it('should filter interrupts by workflow name', () => {
    manager.addInterrupt(makeInterrupt({ threadId: 't1', workflowName: 'wf-a' }));
    manager.addInterrupt(makeInterrupt({ threadId: 't2', workflowName: 'wf-b' }));
    manager.addInterrupt(makeInterrupt({ threadId: 't3', workflowName: 'wf-a' }));

    const results = manager.getInterruptsByWorkflow('wf-a');
    assert.equal(results.length, 2);
  });

  it('should exclude resolved interrupts from workflow filter', () => {
    manager.addInterrupt(makeInterrupt({ threadId: 't1', workflowName: 'wf-a' }));
    manager.addInterrupt(makeInterrupt({ threadId: 't2', workflowName: 'wf-a', resolved: true }));

    const results = manager.getInterruptsByWorkflow('wf-a');
    assert.equal(results.length, 1);
    assert.equal(results[0]!.threadId, 't1');
  });

  it('should expire interrupts after TTL', () => {
    // Add an interrupt with timestamp in the past (> 1 hour ago)
    const oldTimestamp = Date.now() - 3700000; // 1h + 100s
    manager.addInterrupt(makeInterrupt({ threadId: 'old', timestamp: oldTimestamp }));

    const result = manager.getInterrupt('old');
    assert.equal(result, undefined);
  });

  it('should count active interrupts', () => {
    manager.addInterrupt(makeInterrupt({ threadId: 't1' }));
    manager.addInterrupt(makeInterrupt({ threadId: 't2' }));

    assert.equal(manager.getInterruptCount(), 2);
  });

  it('should clear all interrupts', () => {
    manager.addInterrupt(makeInterrupt({ threadId: 't1' }));
    manager.addInterrupt(makeInterrupt({ threadId: 't2' }));

    manager.clear();

    assert.equal(manager.getInterruptCount(), 0);
  });

  it('should cleanup expired interrupts on add', () => {
    const oldTimestamp = Date.now() - 3700000;
    manager.addInterrupt(makeInterrupt({ threadId: 'old', timestamp: oldTimestamp }));
    // Adding a new interrupt triggers cleanup
    manager.addInterrupt(makeInterrupt({ threadId: 'new' }));

    assert.equal(manager.getInterruptCount(), 1);
  });
});
