import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { TaskStore } from '../../lib/tasks/task-store.ts';

describe('TaskStore', () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore({ maxTasks: 10, taskTTL: 60000, cleanupInterval: 999999 });
  });

  afterEach(() => {
    store.destroy();
  });

  it('should create a task with correct defaults', () => {
    const task = store.create('agent', 'test-agent', { query: 'hello' });

    assert.ok(task.id.startsWith('task_'));
    assert.equal(task.kind, 'agent');
    assert.equal(task.target, 'test-agent');
    assert.equal(task.status, 'submitted');
    assert.deepEqual(task.input, { query: 'hello' });
    assert.ok(task.createdAt > 0);
  });

  it('should create a task with sessionId', () => {
    const task = store.create('agent', 'a', {}, 'session-1');
    assert.equal(task.sessionId, 'session-1');
  });

  it('should retrieve a task by id', () => {
    const task = store.create('workflow', 'wf1', { input: 'test' });
    const retrieved = store.get(task.id);

    assert.ok(retrieved);
    assert.equal(retrieved.id, task.id);
  });

  it('should return undefined for non-existent task', () => {
    assert.equal(store.get('nonexistent'), undefined);
  });

  it('should update task status', () => {
    const task = store.create('agent', 'a', {});
    const updated = store.update(task.id, { status: 'working' });

    assert.ok(updated);
    assert.equal(updated.status, 'working');
    assert.ok(updated.updatedAt >= task.updatedAt);
  });

  it('should update task with result', () => {
    const task = store.create('agent', 'a', {});
    store.update(task.id, { status: 'completed', result: { output: 'done', metadata: { duration: 100 } } as any });

    const result = store.get(task.id);
    assert.equal(result!.status, 'completed');
    assert.ok(result!.result);
  });

  it('should return undefined when updating non-existent task', () => {
    assert.equal(store.update('nonexistent', { status: 'working' }), undefined);
  });

  it('should list all tasks sorted by createdAt desc', () => {
    store.create('agent', 'a1', {});
    store.create('workflow', 'w1', {});
    store.create('agent', 'a2', {});

    const tasks = store.list();
    assert.equal(tasks.length, 3);
    assert.ok(tasks[0]!.createdAt >= tasks[1]!.createdAt);
  });

  it('should filter tasks by status', () => {
    const t1 = store.create('agent', 'a', {});
    store.create('agent', 'b', {});
    store.update(t1.id, { status: 'working' });

    const working = store.list({ status: 'working' });
    assert.equal(working.length, 1);
    assert.equal(working[0]!.id, t1.id);
  });

  it('should filter tasks by kind', () => {
    store.create('agent', 'a', {});
    store.create('workflow', 'w', {});

    assert.equal(store.list({ kind: 'agent' }).length, 1);
    assert.equal(store.list({ kind: 'workflow' }).length, 1);
  });

  it('should filter tasks by target', () => {
    store.create('agent', 'alpha', {});
    store.create('agent', 'beta', {});

    assert.equal(store.list({ target: 'alpha' }).length, 1);
  });

  it('should evict oldest terminal task when maxTasks reached', () => {
    const smallStore = new TaskStore({ maxTasks: 3, taskTTL: 60000, cleanupInterval: 999999 });

    const t1 = smallStore.create('agent', 'a1', {});
    smallStore.update(t1.id, { status: 'completed' });
    smallStore.create('agent', 'a2', {});
    smallStore.create('agent', 'a3', {});

    // This should trigger eviction of t1 (completed/terminal)
    smallStore.create('agent', 'a4', {});

    assert.equal(smallStore.get(t1.id), undefined);
    assert.equal(smallStore.list().length, 3);

    smallStore.destroy();
  });

  it('should cleanup expired terminal tasks', () => {
    const task = store.create('agent', 'a', {});
    store.update(task.id, { status: 'completed' });

    // Artificially age the task
    const t = store.get(task.id)!;
    t.updatedAt = Date.now() - 120000; // 2 min ago, TTL is 60s

    store.cleanup();

    assert.equal(store.get(task.id), undefined);
  });

  it('should not cleanup non-terminal tasks', () => {
    const task = store.create('agent', 'a', {});
    store.update(task.id, { status: 'working' });

    // Even if old
    const t = store.get(task.id)!;
    t.updatedAt = Date.now() - 120000;

    store.cleanup();

    assert.ok(store.get(task.id));
  });

  it('should clear all tasks on destroy', () => {
    store.create('agent', 'a', {});
    store.create('workflow', 'w', {});

    store.destroy();

    assert.equal(store.list().length, 0);
  });
});
