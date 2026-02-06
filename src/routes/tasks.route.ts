import type { FastifyPluginAsync } from 'fastify';
import type { TaskStatus, TaskKind } from '../../lib/tasks/types.js';

interface TaskIdParams {
  id: string;
}

interface SubmitAgentBody {
  agent: string;
  input: Record<string, unknown>;
  sessionId?: string;
}

interface SubmitWorkflowBody {
  workflow: string;
  input: Record<string, unknown>;
}

interface RespondBody {
  response: string;
}

interface ListQuery {
  status?: TaskStatus;
  kind?: TaskKind;
  target?: string;
}

export const tasksRoutes: FastifyPluginAsync = async (fastify) => {
  const getManager = () => fastify.orchestrator.tasks.getManager();

  // List tasks with optional filters
  fastify.get<{ Querystring: ListQuery }>('/', async (request) => {
    const { status, kind, target } = request.query;
    return getManager().listTasks({ status, kind, target });
  });

  // Get single task
  fastify.get<{ Params: TaskIdParams }>('/:id', async (request, reply) => {
    const task = getManager().getTask(request.params.id);
    if (!task) {
      return reply.status(404).send({ error: 'Task not found', id: request.params.id });
    }
    return task;
  });

  // Submit agent task
  fastify.post<{ Body: SubmitAgentBody }>('/agent', async (request, reply) => {
    const { agent, input, sessionId } = request.body;

    if (!agent || !input) {
      return reply.status(400).send({ error: 'agent and input are required' });
    }

    const agentDef = fastify.orchestrator.agents.get(agent);
    if (!agentDef) {
      return reply.status(404).send({ error: `Agent not found: ${agent}` });
    }

    const task = getManager().submitAgent({ agent, input, sessionId });
    return reply.status(202).send(task);
  });

  // Submit workflow task
  fastify.post<{ Body: SubmitWorkflowBody }>('/workflow', async (request, reply) => {
    const { workflow, input } = request.body;

    if (!workflow || !input) {
      return reply.status(400).send({ error: 'workflow and input are required' });
    }

    const workflowDef = fastify.orchestrator.workflows.get(workflow);
    if (!workflowDef) {
      return reply.status(404).send({ error: `Workflow not found: ${workflow}` });
    }

    const task = getManager().submitWorkflow({ workflow, input });
    return reply.status(202).send(task);
  });

  // Cancel task
  fastify.post<{ Params: TaskIdParams }>('/:id/cancel', async (request, reply) => {
    const task = getManager().getTask(request.params.id);
    if (!task) {
      return reply.status(404).send({ error: 'Task not found', id: request.params.id });
    }

    const updated = getManager().cancelTask(request.params.id);
    if (!updated) {
      return reply.status(409).send({
        error: 'Task cannot be canceled',
        id: request.params.id,
        status: task.status,
      });
    }

    return updated;
  });

  // Respond to input-required task
  fastify.post<{ Params: TaskIdParams; Body: RespondBody }>(
    '/:id/respond',
    async (request, reply) => {
      const { response } = request.body;
      if (!response) {
        return reply.status(400).send({ error: 'response is required' });
      }

      const task = getManager().getTask(request.params.id);
      if (!task) {
        return reply.status(404).send({ error: 'Task not found', id: request.params.id });
      }

      const updated = getManager().respondToInput(request.params.id, response);
      if (!updated) {
        return reply.status(409).send({
          error: 'Task is not awaiting input',
          id: request.params.id,
          status: task.status,
        });
      }

      return reply.status(202).send(updated);
    }
  );

  // SSE stream for task status changes
  fastify.get<{ Params: TaskIdParams }>('/:id/stream', async (request, reply) => {
    const task = getManager().getTask(request.params.id);
    if (!task) {
      return reply.status(404).send({ error: 'Task not found', id: request.params.id });
    }

    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');

    const TERMINAL_STATUSES = ['completed', 'failed', 'canceled'];
    let lastStatus = '';

    const emit = (data: Record<string, unknown>) => {
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const poll = setInterval(() => {
      const current = getManager().getTask(request.params.id);
      if (!current) {
        emit({ type: 'error', error: 'Task not found' });
        cleanup();
        return;
      }

      if (current.status !== lastStatus) {
        lastStatus = current.status;
        emit({
          type: 'status',
          taskId: current.id,
          status: current.status,
          updatedAt: current.updatedAt,
          ...(current.result && { result: current.result }),
          ...(current.error && { error: current.error }),
          ...(current.inputRequest && { inputRequest: current.inputRequest }),
        });

        if (TERMINAL_STATUSES.includes(current.status)) {
          emit({ type: 'done' });
          cleanup();
        }
      }
    }, 500);

    const cleanup = () => {
      clearInterval(poll);
      reply.raw.end();
    };

    request.raw.on('close', cleanup);

    // Send initial status immediately
    lastStatus = task.status;
    emit({
      type: 'status',
      taskId: task.id,
      status: task.status,
      updatedAt: task.updatedAt,
    });

    if (TERMINAL_STATUSES.includes(task.status)) {
      emit({ type: 'done' });
      cleanup();
    }
  });
};
