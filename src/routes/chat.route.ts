import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { randomBytes, timingSafeEqual } from 'crypto';
import type { FastifyPluginAsync } from 'fastify';
import { resolvePublishConfig } from '../../lib/agents/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// In-memory token store: token -> { agentName, expiresAt }
const chatTokens = new Map<string, { agentName: string; expiresAt: number }>();
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function createChatToken(agentName: string): string {
  const token = randomBytes(32).toString('hex');
  chatTokens.set(token, { agentName, expiresAt: Date.now() + TOKEN_TTL_MS });
  return token;
}

function validateChatToken(token: string, agentName: string): boolean {
  const entry = chatTokens.get(token);
  if (!entry) return false;
  if (entry.agentName !== agentName) return false;
  if (Date.now() > entry.expiresAt) {
    chatTokens.delete(token);
    return false;
  }
  return true;
}

// Periodic cleanup of expired tokens
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of chatTokens) {
    if (now > entry.expiresAt) chatTokens.delete(token);
  }
}, 60 * 60 * 1000); // every hour

interface AgentParams {
  agentName: string;
}

interface AuthBody {
  password: string;
}

interface StreamBody {
  input: Record<string, unknown>;
  sessionId?: string;
}

export const chatRoutes: FastifyPluginAsync = async (fastify) => {
  // Serve standalone chat HTML page
  fastify.get<{ Params: AgentParams }>('/chat/:agentName', async (request, reply) => {
    const agent = fastify.orchestrator.agents.get(request.params.agentName);
    if (!agent) {
      return reply.status(404).send('Not Found');
    }

    const publish = resolvePublishConfig(agent.publish);
    if (!publish.enabled) {
      return reply.status(404).send('Not Found');
    }

    const htmlPath = path.join(__dirname, '..', '..', 'public', 'chat.html');
    const html = fs.readFileSync(htmlPath, 'utf-8');
    reply.type('text/html').send(html);
  });

  // Get agent config for standalone chat (no password exposed)
  fastify.get<{ Params: AgentParams }>('/api/chat/:agentName/config', async (request, reply) => {
    const agent = fastify.orchestrator.agents.get(request.params.agentName);
    if (!agent) {
      return reply.status(404).send({ error: 'Agent not found' });
    }

    const publish = resolvePublishConfig(agent.publish);
    if (!publish.enabled) {
      return reply.status(404).send({ error: 'Agent not found' });
    }

    return {
      name: agent.name,
      description: agent.description,
      inputVariables: agent.prompt.inputVariables,
      requiresPassword: !!publish.password,
      sampleQuestions: agent.sampleQuestions,
    };
  });

  // Authenticate with agent-specific password
  fastify.post<{ Params: AgentParams; Body: AuthBody }>(
    '/api/chat/:agentName/auth',
    async (request, reply) => {
      const agent = fastify.orchestrator.agents.get(request.params.agentName);
      if (!agent) {
        return reply.status(404).send({ error: 'Agent not found' });
      }

      const publish = resolvePublishConfig(agent.publish);
      if (!publish.enabled) {
        return reply.status(404).send({ error: 'Agent not found' });
      }

      if (!publish.password) {
        return reply.status(400).send({ error: 'Agent does not require authentication' });
      }

      const { password } = request.body ?? {};
      if (!password) {
        return reply.status(401).send({ error: 'Password required' });
      }

      try {
        const match = timingSafeEqual(
          Buffer.from(password),
          Buffer.from(publish.password)
        );
        if (!match) {
          return reply.status(401).send({ error: 'Invalid password' });
        }
      } catch {
        return reply.status(401).send({ error: 'Invalid password' });
      }

      const token = createChatToken(request.params.agentName);
      return { token };
    }
  );

  // Stream agent responses (same SSE format as agents.route.ts)
  fastify.post<{ Params: AgentParams; Body: StreamBody }>(
    '/api/chat/:agentName/stream',
    async (request, reply) => {
      const { agentName } = request.params;
      const agent = fastify.orchestrator.agents.get(agentName);
      if (!agent) {
        return reply.status(404).send({ error: 'Agent not found' });
      }

      const publish = resolvePublishConfig(agent.publish);
      if (!publish.enabled) {
        return reply.status(404).send({ error: 'Agent not found' });
      }

      // Validate chat token if password-protected
      if (publish.password) {
        const token = request.headers['x-chat-token'] as string | undefined;
        if (!token || !validateChatToken(token, agentName)) {
          return reply.status(401).send({ error: 'Unauthorized' });
        }
      }

      const { input, sessionId } = request.body;

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
        const stream = fastify.orchestrator.streamAgent(
          agentName,
          input,
          sessionId,
          abortController.signal
        );

        for await (const chunk of stream) {
          if (abortController.signal.aborted) break;
          if (typeof chunk === 'string') {
            reply.raw.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
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
};
