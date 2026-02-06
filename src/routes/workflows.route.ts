import type { FastifyPluginAsync } from 'fastify';

interface WorkflowParams {
  name: string;
}

interface RunBody {
  input: Record<string, unknown>;
}

export const workflowsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async () => {
    const workflows = fastify.orchestrator.workflows.list();
    return workflows.map((workflow) => ({
      name: workflow.name,
      description: workflow.description,
      version: workflow.version,
      type: workflow.type || 'steps',
      steps: workflow.type === 'langgraph' ? 0 : workflow.steps.length,
      inputSchema: workflow.input.schema,
    }));
  });

  fastify.get<{ Params: WorkflowParams }>('/:name', async (request, reply) => {
    const workflow = fastify.orchestrator.workflows.get(request.params.name);

    if (!workflow) {
      return reply.status(404).send({
        error: 'Workflow not found',
        name: request.params.name,
      });
    }

    return workflow;
  });

  fastify.post<{ Params: WorkflowParams; Body: RunBody }>(
    '/:name/run',
    async (request, reply) => {
      const { name } = request.params;
      const { input } = request.body;
      const taskManager = fastify.orchestrator.tasks.getManager();
      const task = taskManager.track('workflow', name, input);

      try {
        const result = await fastify.orchestrator.runWorkflow(name, input);
        taskManager.resolve(task.id, result);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        taskManager.reject(task.id, error);

        if (message.includes('not found')) {
          return reply.status(404).send({ error: message });
        }

        return reply.status(500).send({ error: message });
      }
    }
  );

  fastify.post<{ Params: WorkflowParams; Body: RunBody }>(
    '/:name/stream',
    async (request, reply) => {
      const { name } = request.params;
      const { input } = request.body;
      const taskManager = fastify.orchestrator.tasks.getManager();
      const task = taskManager.track('workflow', name, input);

      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');

      try {
        const stream = fastify.orchestrator.streamWorkflow(name, input);

        for await (const update of stream) {
          reply.raw.write(`data: ${JSON.stringify(update)}\n\n`);
        }

        taskManager.resolve(task.id, { output: 'stream completed' });
        reply.raw.write('data: [DONE]\n\n');
        reply.raw.end();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        taskManager.reject(task.id, error);
        reply.raw.write(`data: ${JSON.stringify({ type: 'error', error: message })}\n\n`);
        reply.raw.end();
      }
    }
  );
};
