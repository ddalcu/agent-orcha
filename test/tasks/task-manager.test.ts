import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { TaskManager } from '../../lib/tasks/task-manager.ts';

describe('TaskManager', () => {
  let manager: TaskManager;

  const mockOrchestrator = {
    runAgent: async () => ({ output: 'done', metadata: { duration: 10 } }),
    runWorkflow: async () => ({ output: { result: 'done' }, metadata: { duration: 10, stepsExecuted: 1, success: true }, stepResults: {} }),
    resumeReactWorkflow: async () => ({ output: {}, metadata: { duration: 0, stepsExecuted: 0, success: true }, stepResults: {} }),
  } as any;

  beforeEach(() => {
    manager = new TaskManager(mockOrchestrator, { maxTasks: 100, taskTTL: 60000, cleanupInterval: 999999 });
  });

  afterEach(() => {
    manager.destroy();
  });

  it('should submit an agent task', () => {
    const task = manager.submitAgent({ agent: 'test-agent', input: { query: 'hello' } });

    assert.ok(task.id);
    assert.equal(task.kind, 'agent');
    assert.equal(task.target, 'test-agent');
  });

  it('should submit a workflow task', () => {
    const task = manager.submitWorkflow({ workflow: 'test-wf', input: { query: 'hello' } });

    assert.ok(task.id);
    assert.equal(task.kind, 'workflow');
    assert.equal(task.target, 'test-wf');
  });

  it('should get a task by id', () => {
    const task = manager.submitAgent({ agent: 'a', input: {} });
    const retrieved = manager.getTask(task.id);

    assert.ok(retrieved);
    assert.equal(retrieved.id, task.id);
  });

  it('should return undefined for non-existent task', () => {
    assert.equal(manager.getTask('nonexistent'), undefined);
  });

  it('should list tasks', () => {
    manager.submitAgent({ agent: 'a1', input: {} });
    manager.submitWorkflow({ workflow: 'w1', input: {} });

    const tasks = manager.listTasks();
    assert.equal(tasks.length, 2);
  });

  it('should cancel a task', () => {
    const task = manager.submitAgent({ agent: 'a', input: {} });
    const canceled = manager.cancelTask(task.id);

    assert.ok(canceled);
    assert.equal(canceled.status, 'canceled');
  });

  it('should return undefined when canceling non-existent task', () => {
    assert.equal(manager.cancelTask('nonexistent'), undefined);
  });

  it('should return undefined when canceling already completed task', async () => {
    const failOrchestrator = {
      runAgent: async () => {
        // Simulate quick completion
        return { output: 'done', metadata: { duration: 0 } };
      },
    } as any;

    const quickManager = new TaskManager(failOrchestrator, { cleanupInterval: 999999 });
    const task = quickManager.submitAgent({ agent: 'a', input: {} });

    // Wait for task to complete
    await new Promise(r => setTimeout(r, 50));

    const result = quickManager.cancelTask(task.id);
    assert.equal(result, undefined);

    quickManager.destroy();
  });

  it('should abort registered controller on cancel', () => {
    const task = manager.submitAgent({ agent: 'a', input: {} });

    const controller = new AbortController();
    manager.registerAbort(task.id, controller);

    manager.cancelTask(task.id);

    assert.equal(controller.signal.aborted, true);
  });

  it('should track and resolve a task', () => {
    const task = manager.track('agent', 'a', { query: 'test' });
    assert.equal(task.status, 'working');

    manager.resolve(task.id, { output: 'result', metadata: { duration: 10 } } as any);

    const resolved = manager.getTask(task.id);
    assert.equal(resolved!.status, 'completed');
  });

  it('should track and reject a task', () => {
    const task = manager.track('agent', 'a', {});
    manager.reject(task.id, new Error('oops'));

    const rejected = manager.getTask(task.id);
    assert.equal(rejected!.status, 'failed');
    assert.ok(rejected!.error!.includes('oops'));
  });

  it('should not resolve a canceled task', () => {
    const task = manager.track('agent', 'a', {});
    manager.cancelTask(task.id);
    manager.resolve(task.id, {} as any);

    const t = manager.getTask(task.id);
    assert.equal(t!.status, 'canceled');
  });

  it('should not reject a canceled task', () => {
    const task = manager.track('agent', 'a', {});
    manager.cancelTask(task.id);
    manager.reject(task.id, new Error('late error'));

    const t = manager.getTask(task.id);
    assert.equal(t!.status, 'canceled');
  });

  it('should not reject a non-existent task', () => {
    // Should not throw
    manager.reject('nonexistent', new Error('oops'));
  });

  it('should not resolve a non-existent task', () => {
    // Should not throw
    manager.resolve('nonexistent', {} as any);
  });

  it('should register and unregister abort controllers', () => {
    const task = manager.track('agent', 'a', {});
    const controller = new AbortController();
    manager.registerAbort(task.id, controller);
    manager.unregisterAbort(task.id);

    // Canceling should not abort since unregistered
    manager.cancelTask(task.id);
    assert.equal(controller.signal.aborted, false);
  });

  it('should handle agent task failure', async () => {
    const failOrchestrator = {
      runAgent: async () => { throw new Error('LLM error'); },
    } as any;

    const failManager = new TaskManager(failOrchestrator, { cleanupInterval: 999999 });
    const task = failManager.submitAgent({ agent: 'a', input: {} });

    // Wait for async rejection
    await new Promise(r => setTimeout(r, 50));

    const t = failManager.getTask(task.id);
    assert.equal(t!.status, 'failed');
    assert.ok(t!.error!.includes('LLM error'));

    failManager.destroy();
  });

  it('should handle workflow task failure', async () => {
    const failOrchestrator = {
      runWorkflow: async () => { throw new Error('WF error'); },
    } as any;

    const failManager = new TaskManager(failOrchestrator, { cleanupInterval: 999999 });
    const task = failManager.submitWorkflow({ workflow: 'w', input: {} });

    await new Promise(r => setTimeout(r, 50));

    const t = failManager.getTask(task.id);
    assert.equal(t!.status, 'failed');
    assert.ok(t!.error!.includes('WF error'));

    failManager.destroy();
  });

  it('should handle workflow task with interrupt', async () => {
    const interruptOrchestrator = {
      runWorkflow: async () => ({
        output: { interrupted: true, question: 'What next?', threadId: 'thread-1' },
        metadata: { duration: 10, stepsExecuted: 1, success: true },
        stepResults: {},
      }),
    } as any;

    const intManager = new TaskManager(interruptOrchestrator, { cleanupInterval: 999999 });
    const task = intManager.submitWorkflow({ workflow: 'w', input: {} });

    await new Promise(r => setTimeout(r, 50));

    const t = intManager.getTask(task.id);
    assert.equal(t!.status, 'input-required');
    assert.ok(t!.inputRequest);
    assert.equal(t!.inputRequest!.question, 'What next?');

    intManager.destroy();
  });

  it('should respond to input on input-required task', async () => {
    const interruptOrchestrator = {
      runWorkflow: async () => ({
        output: { interrupted: true, question: 'Q?', threadId: 'th-1' },
        metadata: { duration: 10, stepsExecuted: 1, success: true },
        stepResults: {},
      }),
      resumeReactWorkflow: async () => ({
        output: { result: 'resumed' },
        metadata: { duration: 5, stepsExecuted: 1, success: true },
        stepResults: {},
      }),
    } as any;

    const intManager = new TaskManager(interruptOrchestrator, { cleanupInterval: 999999 });
    const task = intManager.submitWorkflow({ workflow: 'w', input: {} });

    await new Promise(r => setTimeout(r, 50));

    const result = intManager.respondToInput(task.id, 'my answer');
    assert.ok(result);
    assert.equal(result!.status, 'working');

    intManager.destroy();
  });

  it('should return undefined for respondToInput on non-existent task', () => {
    assert.equal(manager.respondToInput('nonexistent', 'answer'), undefined);
  });

  it('should return undefined for respondToInput on non-input-required task', () => {
    const task = manager.track('agent', 'a', {});
    assert.equal(manager.respondToInput(task.id, 'answer'), undefined);
  });

  it('should list tasks with filters', () => {
    manager.submitAgent({ agent: 'a1', input: {} });
    manager.submitWorkflow({ workflow: 'w1', input: {} });

    const agentTasks = manager.listTasks({ kind: 'agent' });
    assert.equal(agentTasks.length, 1);
    assert.equal(agentTasks[0]!.kind, 'agent');
  });

  it('should track with sessionId', () => {
    const task = manager.track('agent', 'a', { q: 'hi' }, 'session-1');
    assert.ok(task);
    assert.equal(task.status, 'working');
  });

  it('respondToInput should complete task after resume', async () => {
    const resumeOrch = {
      runAgent: async () => ({ output: 'done', metadata: { duration: 10 } }),
      runWorkflow: async () => ({ output: {}, metadata: { duration: 0, stepsExecuted: 0, success: true }, stepResults: {} }),
      resumeReactWorkflow: async () => ({ output: { result: 'resumed' }, metadata: { duration: 10, stepsExecuted: 1, success: true }, stepResults: {} }),
    } as any;

    const mgr = new TaskManager(resumeOrch, { maxTasks: 100, taskTTL: 60000, cleanupInterval: 999999 });

    // Create a task in input-required state
    const task = mgr.track('workflow', 'test-wf', {});
    (mgr as any).store.update(task.id, {
      status: 'input-required',
      inputRequest: { question: 'Continue?', threadId: 'thread-1', timestamp: Date.now() },
    });

    const result = mgr.respondToInput(task.id, 'yes');
    assert.ok(result);

    // Wait for the async resume to complete
    await new Promise(resolve => setTimeout(resolve, 50));

    const updated = mgr.getTask(task.id);
    assert.equal(updated?.status, 'completed');

    mgr.destroy();
  });

  it('respondToInput should handle interrupted output', async () => {
    const interruptOrch = {
      runAgent: async () => ({ output: 'done', metadata: { duration: 10 } }),
      runWorkflow: async () => ({ output: {}, metadata: { duration: 0, stepsExecuted: 0, success: true }, stepResults: {} }),
      resumeReactWorkflow: async () => ({
        output: { interrupted: true, question: 'Another question?', threadId: 'thread-2' },
        metadata: { duration: 10, stepsExecuted: 1, success: true },
        stepResults: {},
      }),
    } as any;

    const mgr = new TaskManager(interruptOrch, { maxTasks: 100, taskTTL: 60000, cleanupInterval: 999999 });

    const task = mgr.track('workflow', 'test-wf', {});
    (mgr as any).store.update(task.id, {
      status: 'input-required',
      inputRequest: { question: 'Continue?', threadId: 'thread-1', timestamp: Date.now() },
    });

    mgr.respondToInput(task.id, 'maybe');

    await new Promise(resolve => setTimeout(resolve, 50));

    const updated = mgr.getTask(task.id);
    assert.equal(updated?.status, 'input-required');

    mgr.destroy();
  });

  it('respondToInput should handle error in resume', async () => {
    const errorOrch = {
      runAgent: async () => ({ output: 'done', metadata: { duration: 10 } }),
      runWorkflow: async () => ({ output: {}, metadata: { duration: 0, stepsExecuted: 0, success: true }, stepResults: {} }),
      resumeReactWorkflow: async () => { throw new Error('Resume failed'); },
    } as any;

    const mgr = new TaskManager(errorOrch, { maxTasks: 100, taskTTL: 60000, cleanupInterval: 999999 });

    const task = mgr.track('workflow', 'test-wf', {});
    (mgr as any).store.update(task.id, {
      status: 'input-required',
      inputRequest: { question: 'Continue?', threadId: 'thread-1', timestamp: Date.now() },
    });

    mgr.respondToInput(task.id, 'yes');

    await new Promise(resolve => setTimeout(resolve, 50));

    const updated = mgr.getTask(task.id);
    assert.equal(updated?.status, 'failed');
    assert.ok(updated?.error?.includes('Resume failed'));

    mgr.destroy();
  });
});
