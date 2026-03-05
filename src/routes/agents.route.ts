import type { FastifyPluginAsync } from 'fastify';
import { resolvePublishConfig } from '../../lib/agents/types.ts';
import type { ContentPart } from '../../lib/types/llm-types.ts';

interface AgentParams {
  name: string;
}

interface InvokeBody {
  input: Record<string, unknown>;
  sessionId?: string;
}

/** Strip base64 image data from tool output so stored events stay small. */
function summarizeOutput(output: unknown): unknown {
  if (typeof output === 'string') return output.length > 500 ? output.slice(0, 500) + '...' : output;
  if (Array.isArray(output)) {
    return output.map((p: any) => {
      if (p?.type === 'image') return { type: 'image', mediaType: p.mediaType, bytes: p.data?.length ?? 0 };
      if (p?.type === 'text') return p;
      return p;
    });
  }
  return output;
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

    const publish = resolvePublishConfig(agent.publish);
    const { publish: _publish, ...rest } = agent;
    return {
      ...rest,
      publish: { enabled: publish.enabled, hasPassword: !!publish.password },
    };
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

        // Accumulate streaming text chunks into complete events
        let pendingText = { type: '', content: '', timestamp: 0 };
        let lastThinkingContent = '';

        const flushPendingText = () => {
          const text = pendingText.content.trim();
          if (!text) { pendingText = { type: '', content: '', timestamp: 0 }; return; }
          // Deduplicate repeated identical thinking blocks from misbehaving models
          if (pendingText.type === 'thinking' && text === lastThinkingContent) {
            pendingText = { type: '', content: '', timestamp: 0 };
            return;
          }
          if (pendingText.type === 'thinking') lastThinkingContent = text;
          taskManager.addEvent(task.id, {
            type: pendingText.type as any,
            timestamp: pendingText.timestamp,
            content: text,
          });
          pendingText = { type: '', content: '', timestamp: 0 };
        };

        for await (const chunk of stream) {
          if (abortController.signal.aborted) break;
          if (typeof chunk === 'string') {
            reply.raw.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
          } else {
            const evt = chunk as Record<string, unknown>;
            // Update task metrics on react-loop iterations
            if (evt.type === 'react_iteration') {
              const { type: _, ...metrics } = evt;
              taskManager.updateMetrics(task.id, metrics as any);
            }
            // Accumulate thinking/content chunks into single events
            if (evt.type === 'thinking' || evt.type === 'content') {
              if (pendingText.type && pendingText.type !== evt.type) flushPendingText();
              if (!pendingText.type) { pendingText.type = evt.type as string; pendingText.timestamp = Date.now(); }
              pendingText.content += (evt.content as string) || '';
            } else if (evt.type === 'tool_start' || evt.type === 'tool_end') {
              // Tool event — flush accumulated text first, then store the tool event
              flushPendingText();
              const event: Record<string, unknown> = { type: evt.type, timestamp: Date.now() };
              if (evt.tool) event.tool = evt.tool;
              if (evt.input !== undefined) event.input = evt.input;
              if (evt.output !== undefined) event.output = summarizeOutput(evt.output);
              taskManager.addEvent(task.id, event as any);
            } else {
              // Other events (react_iteration, usage, etc.) — flush text but don't store
              flushPendingText();
            }
            reply.raw.write(`data: ${JSON.stringify(evt)}\n\n`);
          }
        }
        flushPendingText();

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

  fastify.get<{ Params: { sessionId: string } }>(
    '/sessions/:sessionId/messages',
    async (request, reply) => {
      const { sessionId } = request.params;

      if (!fastify.orchestrator.memory.hasSession(sessionId)) {
        return reply.status(404).send({ error: 'Session not found', sessionId });
      }

      const store = fastify.orchestrator.memory.getStore();
      const rawMessages = store.getMessages(sessionId);
      const messages = rawMessages.map((msg: { role: string; content: unknown; tool_calls?: { name: string }[]; name?: string }) => {
        const entry: Record<string, unknown> = { role: msg.role };

        if (typeof msg.content === 'string') {
          entry.textChars = msg.content.length;
          entry.images = 0;
        } else if (Array.isArray(msg.content)) {
          const parts = msg.content as ContentPart[];
          let textChars = 0;
          let images = 0;
          let imageBytes = 0;
          for (const p of parts) {
            if (p.type === 'text') textChars += p.text.length;
            else if (p.type === 'image') { images++; imageBytes += p.data.length; }
          }
          entry.textChars = textChars;
          entry.images = images;
          if (images > 0) entry.imageBytes = imageBytes;
        }

        if (msg.tool_calls?.length) {
          entry.toolCalls = msg.tool_calls.map((tc) => tc.name);
        }
        if (msg.name) entry.name = msg.name;

        return entry;
      });

      return {
        sessionId,
        messageCount: rawMessages.length,
        messages,
      };
    }
  );
};
