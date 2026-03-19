import type { FastifyPluginAsync } from 'fastify';
import type { P2PManager } from '../../lib/p2p/p2p-manager.ts';

interface InvokeParams {
  peerId: string;
  agentName: string;
}

interface InvokeBody {
  input: Record<string, unknown>;
  sessionId?: string;
}

interface LLMStreamParams {
  peerId: string;
  modelName: string;
}

interface LLMStreamBody {
  message: string;
  sessionId?: string;
}

export const p2pRoutes: FastifyPluginAsync = async (fastify) => {
  function getManager(): P2PManager | null {
    return (fastify.orchestrator as any)._p2pManager ?? null;
  }

  // GET /api/p2p/status
  fastify.get('/status', async () => {
    const manager = getManager();
    if (!manager) {
      return { enabled: false, connected: false, peerCount: 0, peerName: '' };
    }
    return manager.getStatus();
  });

  // GET /api/p2p/peers
  fastify.get('/peers', async (_req, reply) => {
    const manager = getManager();
    if (!manager) return reply.status(200).send([]);
    return manager.getPeers();
  });

  // GET /api/p2p/agents
  fastify.get('/agents', async (_req, reply) => {
    const manager = getManager();
    if (!manager) return reply.status(200).send([]);
    return manager.getRemoteAgents();
  });

  // POST /api/p2p/agents/:peerId/:agentName/stream
  fastify.post<{ Params: InvokeParams; Body: InvokeBody }>(
    '/agents/:peerId/:agentName/stream',
    async (request, reply) => {
      const manager = getManager();
      if (!manager) {
        return reply.status(503).send({ error: 'P2P not enabled' });
      }

      const { peerId, agentName } = request.params;
      const { input, sessionId } = request.body;
      const sid = sessionId || `p2p-${peerId}-${Date.now()}`;

      const abortController = new AbortController();

      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');

      reply.raw.on('close', () => {
        if (!abortController.signal.aborted) {
          abortController.abort();
        }
      });

      try {
        const stream = manager.invokeRemoteAgent(peerId, agentName, input, sid, abortController.signal);

        for await (const chunk of stream) {
          if (abortController.signal.aborted) break;

          if (typeof chunk === 'string') {
            reply.raw.write(`data: ${JSON.stringify({ type: 'content', content: chunk })}\n\n`);
          } else {
            reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
        }

        if (!abortController.signal.aborted) {
          reply.raw.write('data: [DONE]\n\n');
        }
        reply.raw.end();
      } catch (error) {
        if (abortController.signal.aborted) {
          reply.raw.end();
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        reply.raw.write(`data: ${JSON.stringify({ error: message })}\n\n`);
        reply.raw.end();
      }
    }
  );

  // GET /api/p2p/llms
  fastify.get('/llms', async (_req, reply) => {
    const manager = getManager();
    if (!manager) return reply.status(200).send([]);
    return manager.getRemoteLLMs();
  });

  // POST /api/p2p/llms/:peerId/:modelName/stream
  fastify.post<{ Params: LLMStreamParams; Body: LLMStreamBody }>(
    '/llms/:peerId/:modelName/stream',
    async (request, reply) => {
      const manager = getManager();
      if (!manager) {
        return reply.status(503).send({ error: 'P2P not enabled' });
      }

      const { peerId, modelName } = request.params;
      const { message, sessionId } = request.body;
      const sid = sessionId || `p2p-llm-${peerId}-${Date.now()}`;

      // Manage conversation history on caller side
      const store = fastify.orchestrator.memory.getStore();
      store.addMessage(sid, { role: 'human', content: message });
      const history = store.getMessages(sid);

      const wireMessages = history.map(m => ({
        role: m.role === 'human' ? 'user' : m.role === 'ai' ? 'assistant' : m.role,
        content: typeof m.content === 'string' ? m.content : '',
      }));

      const abortController = new AbortController();

      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');

      reply.raw.on('close', () => {
        if (!abortController.signal.aborted) {
          abortController.abort();
        }
      });

      let fullContent = '';

      try {
        const stream = manager.invokeRemoteLLM(peerId, modelName, wireMessages, undefined, abortController.signal);

        for await (const chunk of stream) {
          if (abortController.signal.aborted) break;

          if (chunk.type === 'content') {
            fullContent += chunk.content;
            reply.raw.write(`data: ${JSON.stringify({ type: 'content', content: chunk.content })}\n\n`);
          } else if (chunk.type === 'thinking') {
            reply.raw.write(`data: ${JSON.stringify({ type: 'thinking', content: chunk.content })}\n\n`);
          } else if (chunk.type === 'usage') {
            reply.raw.write(`data: ${JSON.stringify({ type: 'usage', input_tokens: chunk.input_tokens, output_tokens: chunk.output_tokens, total_tokens: chunk.total_tokens })}\n\n`);
          }
        }

        // Store assistant response
        if (fullContent) {
          store.addMessage(sid, { role: 'ai', content: fullContent });
        }

        if (!abortController.signal.aborted) {
          reply.raw.write('data: [DONE]\n\n');
        }
        reply.raw.end();
      } catch (error) {
        if (abortController.signal.aborted) {
          reply.raw.end();
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        reply.raw.write(`data: ${JSON.stringify({ error: message })}\n\n`);
        reply.raw.end();
      }
    }
  );
};
