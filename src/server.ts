import * as path from 'path';
import { fileURLToPath } from 'url';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import type { Orchestrator } from '../lib/index.ts';
import { TriggerManager } from '../lib/triggers/trigger-manager.ts';
import { agentsRoutes } from './routes/agents.route.ts';
import { workflowsRoutes } from './routes/workflows.route.ts';
import { knowledgeRoutes } from './routes/knowledge.route.ts';
import { llmRoutes } from './routes/llm.route.ts';
import { mcpRoutes } from './routes/mcp.route.ts';
import { functionsRoutes } from './routes/functions.route.ts';
import { skillsRoutes } from './routes/skills.route.ts';
import { filesRoutes } from './routes/files.route.ts';
import { graphRoutes } from './routes/graph.route.ts';
import { tasksRoutes } from './routes/tasks.route.ts';
import { getPinoConfig } from '../lib/logger.ts';
import { authPlugin } from './middleware/auth.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

declare module 'fastify' {
  interface FastifyInstance {
    orchestrator: Orchestrator;
  }
}

export async function createServer(orchestrator: Orchestrator): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: getPinoConfig(),
    disableRequestLogging: true,
  });

  await fastify.register(cors, {
    origin: process.env['CORS_ORIGIN'] ?? true,
  });

  await fastify.register(authPlugin);

  await fastify.register(fastifyStatic, {
    root: path.join(__dirname, '..', 'public'),
    prefix: '/',
  });

  fastify.decorate('orchestrator', orchestrator);

  fastify.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  await fastify.register(agentsRoutes, { prefix: '/api/agents' });
  await fastify.register(workflowsRoutes, { prefix: '/api/workflows' });
  await fastify.register(knowledgeRoutes, { prefix: '/api/knowledge' });
  await fastify.register(llmRoutes, { prefix: '/api/llm' });
  await fastify.register(mcpRoutes, { prefix: '/api/mcp' });
  await fastify.register(functionsRoutes, { prefix: '/api/functions' });
  await fastify.register(skillsRoutes, { prefix: '/api/skills' });
  await fastify.register(filesRoutes, { prefix: '/api/files' });
  await fastify.register(graphRoutes, { prefix: '/api/graph' });
  await fastify.register(tasksRoutes, { prefix: '/api/tasks' });

  // Start triggers (cron + webhooks) after all routes are registered
  const triggerManager = new TriggerManager();
  await triggerManager.start(orchestrator, fastify);
  orchestrator.triggers.setManager(triggerManager);

  return fastify;
}
