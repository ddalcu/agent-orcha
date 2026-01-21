import * as path from 'path';
import { fileURLToPath } from 'url';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import type { Orchestrator } from '../lib/index.js';
import { agentsRoutes } from './routes/agents.route.js';
import { workflowsRoutes } from './routes/workflows.route.js';
import { vectorsRoutes } from './routes/vectors.route.js';
import { llmRoutes } from './routes/llm.route.js';
import { getPinoConfig } from '../lib/logger.js';

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
  await fastify.register(vectorsRoutes, { prefix: '/api/vectors' });
  await fastify.register(llmRoutes, { prefix: '/api/llm' });

  return fastify;
}
