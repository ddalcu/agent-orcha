import type { FastifyPluginAsync } from 'fastify';
import { resolvePublishConfig } from '../../lib/agents/types.ts';

interface AgentParams {
  name: string;
}

interface InvokeBody {
  input: Record<string, unknown>;
  sessionId?: string;
}

export const agentsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async () => {
    const agents = fastify.orchestrator.agents.list();
    return agents.map((agent) => {
      const publish = resolvePublishConfig(agent.publish);
      return {
        name: agent.name,
        description: agent.description,
        version: agent.version,
        tools: agent.tools,
        memory: agent.memory,
        inputVariables: agent.prompt.inputVariables,
        publish: { enabled: publish.enabled, hasPassword: !!publish.password },
        sampleQuestions: agent.sampleQuestions,
      };
    });
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
      const { input, sessionId } = request.body;
      const taskManager = fastify.orchestrator.tasks.getManager();
      const task = taskManager.track('agent', name, input, sessionId);

      try {
        const result = await fastify.orchestrator.runAgent(name, input, sessionId);
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

  fastify.post<{ Params: AgentParams; Body: InvokeBody }>(
    '/:name/stream',
    async (request, reply) => {
      const { name } = request.params;
      const { input, sessionId } = request.body;
      const taskManager = fastify.orchestrator.tasks.getManager();
      const task = taskManager.track('agent', name, input, sessionId);

      // Create an AbortController that cancels the LLM stream on client disconnect or task cancel
      const abortController = new AbortController();
      taskManager.registerAbort(task.id, abortController);

      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');

      // Abort the LLM stream when the client disconnects (socket close, not request body close)
      reply.raw.on('close', () => {
        if (!abortController.signal.aborted) {
          abortController.abort();
        }
      });

      try {
        const stream = fastify.orchestrator.streamAgent(name, input, sessionId, abortController.signal);

        for await (const chunk of stream) {
          if (abortController.signal.aborted) break;
          if (typeof chunk === 'string') {
            reply.raw.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
          } else {
            // Already an event object
            reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
        }

        if (!abortController.signal.aborted) {
          taskManager.resolve(task.id, { output: 'stream completed' });
          reply.raw.write('data: [DONE]\n\n');
        }
        reply.raw.end();
      } catch (error) {
        if (abortController.signal.aborted) {
          // Cancellation — not an error
          reply.raw.end();
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        taskManager.reject(task.id, error);
        reply.raw.write(`data: ${JSON.stringify({ error: message })}\n\n`);
        reply.raw.end();
      } finally {
        taskManager.unregisterAbort(task.id);
      }
    }
  );

  // Session management endpoints
  fastify.get('/sessions/stats', async () => {
    return {
      totalSessions: fastify.orchestrator.memory.getSessionCount(),
    };
  });

  fastify.get<{ Params: { sessionId: string } }>(
    '/sessions/:sessionId',
    async (request, reply) => {
      const { sessionId } = request.params;

      if (!fastify.orchestrator.memory.hasSession(sessionId)) {
        return reply.status(404).send({
          error: 'Session not found',
          sessionId,
        });
      }

      return {
        sessionId,
        messageCount: fastify.orchestrator.memory.getMessageCount(sessionId),
      };
    }
  );

  fastify.delete<{ Params: { sessionId: string } }>(
    '/sessions/:sessionId',
    async (request) => {
      const { sessionId } = request.params;

      fastify.orchestrator.memory.clearSession(sessionId);

      return {
        message: 'Session cleared',
        sessionId,
      };
    }
  );
};
