import type { FastifyPluginAsync } from 'fastify';

interface WorkflowParams {
  name: string;
}

interface RunBody {
  input: Record<string, unknown>;
}

interface ResumeBody {
  threadId: string;
  answer: string;
}

export const workflowsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async () => {
    const workflows = fastify.orchestrator.workflows.list();
    const allAgentNames = fastify.orchestrator.agents.names();

    return workflows.map((workflow) => {
      let agents: string[] = [];
      let tools: string[] = [];

      if (workflow.type === 'react') {
        // Resolve agent names from graph.agents config
        const agentConfig = workflow.graph.agents;
        if (agentConfig.mode === 'all') {
          agents = agentConfig.exclude
            ? allAgentNames.filter((n) => !agentConfig.exclude!.includes(n))
            : [...allAgentNames];
        } else if (agentConfig.mode === 'include' && agentConfig.include) {
          agents = agentConfig.include.filter((n) => allAgentNames.includes(n));
        } else if (agentConfig.mode === 'exclude') {
          agents = agentConfig.exclude
            ? allAgentNames.filter((n) => !agentConfig.exclude!.includes(n))
            : [...allAgentNames];
        }

        // Collect tool info from graph.tools config
        const toolConfig = workflow.graph.tools;
        if (toolConfig.mode !== 'none') {
          tools = toolConfig.include ? [...toolConfig.include] : [...toolConfig.sources];
        }
      } else {
        // Step-based: extract unique agent names from steps
        const stepAgents = new Set<string>();
        for (const step of workflow.steps) {
          if ('parallel' in step) {
            for (const ps of step.parallel) stepAgents.add(ps.agent);
          } else {
            stepAgents.add(step.agent);
          }
        }
        agents = [...stepAgents];
      }

      return {
        name: workflow.name,
        description: workflow.description,
        version: workflow.version,
        type: workflow.type || 'steps',
        chatOutputFormat: workflow.chatOutputFormat || 'json',
        steps: workflow.type === 'react' ? 0 : workflow.steps.length,
        inputSchema: workflow.input.schema,
        sampleQuestions: workflow.sampleQuestions,
        agents,
        tools,
      };
    });
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

      // Send task ID as first event so the client can cancel via the tasks API
      reply.raw.write(`data: ${JSON.stringify({ type: 'task_id', taskId: task.id })}\n\n`);

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

  fastify.post<{ Params: WorkflowParams; Body: ResumeBody }>(
    '/:name/resume',
    async (request, reply) => {
      const { name } = request.params;
      const { threadId, answer } = request.body;

      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');

      try {
        const stream = fastify.orchestrator.streamResumeReactWorkflow(name, threadId, answer);

        for await (const update of stream) {
          reply.raw.write(`data: ${JSON.stringify(update)}\n\n`);
        }

        reply.raw.write('data: [DONE]\n\n');
        reply.raw.end();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reply.raw.write(`data: ${JSON.stringify({ type: 'error', error: message })}\n\n`);
        reply.raw.end();
      }
    }
  );
};
