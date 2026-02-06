import { randomBytes } from 'crypto';
import type { Task, TaskStatus, TaskKind, TaskStoreConfig } from './types.js';
import { logger } from '../logger.js';

const TERMINAL_STATUSES: TaskStatus[] = ['completed', 'failed', 'canceled'];

export class TaskStore {
  private tasks: Map<string, Task>;
  private maxTasks: number;
  private taskTTL: number;
  private cleanupInterval?: NodeJS.Timeout;

  constructor(config: TaskStoreConfig = {}) {
    this.tasks = new Map();
    this.maxTasks = config.maxTasks ?? 1000;
    this.taskTTL = config.taskTTL ?? 3600000; // 1 hour

    const interval = config.cleanupInterval ?? 60000; // 60s
    this.cleanupInterval = setInterval(() => this.cleanup(), interval);
  }

  create(kind: TaskKind, target: string, input: Record<string, unknown>, sessionId?: string): Task {
    if (this.tasks.size >= this.maxTasks) {
      this.evictOldest();
    }

    const now = Date.now();
    const id = `task_${now}_${randomBytes(4).toString('hex')}`;

    const task: Task = {
      id,
      kind,
      target,
      status: 'submitted',
      input,
      sessionId,
      createdAt: now,
      updatedAt: now,
    };

    this.tasks.set(id, task);
    logger.debug(`[TaskStore] Created task ${id} (${kind}:${target})`);
    return task;
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  update(id: string, updates: Partial<Pick<Task, 'status' | 'result' | 'error' | 'inputRequest' | 'completedAt'>>): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;

    Object.assign(task, updates, { updatedAt: Date.now() });
    return task;
  }

  list(filters?: { status?: TaskStatus; kind?: TaskKind; target?: string }): Task[] {
    let results = Array.from(this.tasks.values());

    if (filters?.status) {
      results = results.filter((t) => t.status === filters.status);
    }
    if (filters?.kind) {
      results = results.filter((t) => t.kind === filters.kind);
    }
    if (filters?.target) {
      results = results.filter((t) => t.target === filters.target);
    }

    return results.sort((a, b) => b.createdAt - a.createdAt);
  }

  cleanup(): void {
    const now = Date.now();
    let removedCount = 0;

    for (const [id, task] of this.tasks.entries()) {
      if (TERMINAL_STATUSES.includes(task.status) && now - task.updatedAt > this.taskTTL) {
        this.tasks.delete(id);
        removedCount++;
      }
    }

    if (removedCount > 0) {
      logger.info(`[TaskStore] Cleaned up ${removedCount} expired tasks`);
    }
  }

  private evictOldest(): void {
    // Evict the oldest terminal task first, otherwise oldest overall
    let oldestTerminal: string | undefined;
    let oldestTerminalTime = Infinity;
    let oldestAny: string | undefined;
    let oldestAnyTime = Infinity;

    for (const [id, task] of this.tasks.entries()) {
      if (TERMINAL_STATUSES.includes(task.status) && task.createdAt < oldestTerminalTime) {
        oldestTerminal = id;
        oldestTerminalTime = task.createdAt;
      }
      if (task.createdAt < oldestAnyTime) {
        oldestAny = id;
        oldestAnyTime = task.createdAt;
      }
    }

    const toEvict = oldestTerminal ?? oldestAny;
    if (toEvict) {
      this.tasks.delete(toEvict);
      logger.debug(`[TaskStore] Evicted task ${toEvict} (maxTasks reached)`);
    }
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
    this.tasks.clear();
  }
}
