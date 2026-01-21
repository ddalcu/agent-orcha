import type { FastifyPluginAsync } from 'fastify';

interface AgentParams {
  name: string;
}

interface InvokeBody {
  input: Record<string, unknown>;
}

export const agentsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async () => {
    const agents = fastify.orchestrator.agents.list();
    return agents.map((agent) => ({
      name: agent.name,
      description: agent.description,
      version: agent.version,
      tools: agent.tools,
      inputVariables: agent.prompt.inputVariables,
    }));
  });

  fastify.get<{ Params: AgentParams }>('/:name', async (request, reply) => {
    const agent = fastify.orchestrator.agents.get(request.params.name);

    if (!agent) {
      return reply.status(404).send({
        error: 'Agent not found',
        name: request.params.name,
      });
    }

    return agent;
  });

  fastify.post<{ Params: AgentParams; Body: InvokeBody }>(
    '/:name/invoke',
    async (request, reply) => {
      const { name } = request.params;
      const { input } = request.body;

      try {
        const result = await fastify.orchestrator.runAgent(name, input);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (message.includes('not found')) {
          return reply.status(404).send({ error: message });
        }

        return reply.status(500).send({ error: message });
      }
    }
  );

  fastify.post<{ Params: AgentParams; Body: InvokeBody }>(
    '/:name/stream',
    async (request, reply) => {
      const { name } = request.params;
      const { input } = request.body;

      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');

      try {
        const stream = fastify.orchestrator.streamAgent(name, input);

        for await (const chunk of stream) {
          reply.raw.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
        }

        reply.raw.write('data: [DONE]\n\n');
        reply.raw.end();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reply.raw.write(`data: ${JSON.stringify({ error: message })}\n\n`);
        reply.raw.end();
      }
    }
  );
};
