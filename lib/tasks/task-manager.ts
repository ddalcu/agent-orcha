import type { Orchestrator } from '../orchestrator.js';
import type { SubmitAgentParams, SubmitWorkflowParams, Task, TaskKind, TaskStoreConfig } from './types.js';
import { TaskStore } from './task-store.js';
import { logger } from '../logger.js';

export class TaskManager {
  private store: TaskStore;
  private orchestrator: Orchestrator;
  private abortControllers = new Map<string, AbortController>();

  constructor(orchestrator: Orchestrator, config?: TaskStoreConfig) {
    this.orchestrator = orchestrator;
    this.store = new TaskStore(config);
  }

  registerAbort(taskId: string, controller: AbortController): void {
    this.abortControllers.set(taskId, controller);
  }

  unregisterAbort(taskId: string): void {
    this.abortControllers.delete(taskId);
  }

  submitAgent(params: SubmitAgentParams): Task {
    const task = this.store.create('agent', params.agent, params.input, params.sessionId);

    this.store.update(task.id, { status: 'working' });

    this.orchestrator
      .runAgent(params.agent, params.input, params.sessionId)
      .then((result) => {
        const current = this.store.get(task.id);
        if (current?.status === 'canceled') return;

        this.store.update(task.id, {
          status: 'completed',
          result,
          completedAt: Date.now(),
        });
        logger.debug(`[TaskManager] Agent task ${task.id} completed`);
      })
      .catch((error) => {
        const current = this.store.get(task.id);
        if (current?.status === 'canceled') return;

        this.store.update(task.id, {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
          completedAt: Date.now(),
        });
        logger.error(`[TaskManager] Agent task ${task.id} failed: ${error}`);
      });

    return task;
  }

  submitWorkflow(params: SubmitWorkflowParams): Task {
    const task = this.store.create('workflow', params.workflow, params.input);

    this.store.update(task.id, { status: 'working' });

    this.orchestrator
      .runWorkflow(params.workflow, params.input)
      .then((result) => {
        const current = this.store.get(task.id);
        if (current?.status === 'canceled') return;

        // Detect LangGraph interrupt
        const output = result.output as Record<string, unknown>;
        if (output.interrupted === true) {
          this.store.update(task.id, {
            status: 'input-required',
            result,
            inputRequest: {
              question: output.question as string,
              threadId: output.threadId as string,
              timestamp: Date.now(),
            },
          });
          logger.debug(`[TaskManager] Workflow task ${task.id} requires input`);
          return;
        }

        this.store.update(task.id, {
          status: 'completed',
          result,
          completedAt: Date.now(),
        });
        logger.debug(`[TaskManager] Workflow task ${task.id} completed`);
      })
      .catch((error) => {
        const current = this.store.get(task.id);
        if (current?.status === 'canceled') return;

        this.store.update(task.id, {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
          completedAt: Date.now(),
        });
        logger.error(`[TaskManager] Workflow task ${task.id} failed: ${error}`);
      });

    return task;
  }

  cancelTask(id: string): Task | undefined {
    const task = this.store.get(id);
    if (!task) return undefined;

    if (task.status === 'completed' || task.status === 'failed' || task.status === 'canceled') {
      return undefined;
    }

    // Abort the in-flight LLM/agent stream if one is registered
    const controller = this.abortControllers.get(id);
    if (controller && !controller.signal.aborted) {
      controller.abort();
      logger.info(`[TaskManager] Aborted stream for task ${id}`);
    }
    this.abortControllers.delete(id);

    return this.store.update(id, { status: 'canceled', completedAt: Date.now() });
  }

  respondToInput(id: string, response: string): Task | undefined {
    const task = this.store.get(id);
    if (!task) return undefined;
    if (task.status !== 'input-required' || !task.inputRequest) return undefined;

    const { threadId } = task.inputRequest;

    this.store.update(id, {
      status: 'working',
      inputRequest: undefined,
    });

    this.orchestrator
      .resumeLangGraphWorkflow(task.target, threadId, response)
      .then((result) => {
        const current = this.store.get(id);
        if (current?.status === 'canceled') return;

        const output = result.output as Record<string, unknown>;
        if (output.interrupted === true) {
          this.store.update(id, {
            status: 'input-required',
            result,
            inputRequest: {
              question: output.question as string,
              threadId: output.threadId as string,
              timestamp: Date.now(),
            },
          });
          return;
        }

        this.store.update(id, {
          status: 'completed',
          result,
          completedAt: Date.now(),
        });
      })
      .catch((error) => {
        const current = this.store.get(id);
        if (current?.status === 'canceled') return;

        this.store.update(id, {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
          completedAt: Date.now(),
        });
      });

    return this.store.get(id);
  }

  track(kind: TaskKind, target: string, input: Record<string, unknown>, sessionId?: string): Task {
    const task = this.store.create(kind, target, input, sessionId);
    this.store.update(task.id, { status: 'working' });
    return task;
  }

  resolve(taskId: string, result: Task['result']): void {
    const task = this.store.get(taskId);
    if (!task || task.status === 'canceled') return;

    this.store.update(taskId, {
      status: 'completed',
      result,
      completedAt: Date.now(),
    });
  }

  reject(taskId: string, error: unknown): void {
    const task = this.store.get(taskId);
    if (!task || task.status === 'canceled') return;

    this.store.update(taskId, {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      completedAt: Date.now(),
    });
  }

  getTask(id: string): Task | undefined {
    return this.store.get(id);
  }

  listTasks(filters?: { status?: string; kind?: string; target?: string }) {
    return this.store.list(filters as Parameters<TaskStore['list']>[0]);
  }

  destroy(): void {
    this.store.destroy();
  }
}
