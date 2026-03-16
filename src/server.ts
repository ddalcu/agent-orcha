import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import type { Orchestrator } from '../lib/index.ts';
import { isSea, getPublicDir } from '../lib/sea/bootstrap.ts';
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
import { chatRoutes } from './routes/chat.route.ts';
import { vncRoutes } from './routes/vnc.route.ts';
import { localLlmRoutes } from './routes/local-llm.route.ts';
import { logsRoutes } from './routes/logs.route.ts';
import { publishRoutes } from './routes/publish.route.ts';
import { getPinoConfig } from '../lib/logger.ts';
import { authPlugin } from './middleware/auth.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getVersion(): string {
  if (isSea()) {
    try {
      return (process as any).getBuiltinModule?.('node:sea')?.getAsset('version', 'utf8')?.trim() || '0.0.0';
    } catch { return '0.0.0'; }
  }
  // From src/: one level up. From dist/src/: two levels up.
  for (const rel of ['..', path.join('..', '..')]) {
    const candidate = path.join(__dirname, rel, 'package.json');
    if (fs.existsSync(candidate)) {
      return JSON.parse(fs.readFileSync(candidate, 'utf-8')).version;
    }
  }
  return '0.0.0';
}
const PKG_VERSION = getVersion();

declare module 'fastify' {
  interface FastifyInstance {
    orchestrator: Orchestrator;
    viteDevServer?: import('vite').ViteDevServer;
  }
}

export async function createServer(orchestrator: Orchestrator): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: getPinoConfig(),
    disableRequestLogging: true,
    bodyLimit: 50 * 1024 * 1024, // 50 MB for file attachments
  });

  await fastify.register(cors, {
    origin: process.env['CORS_ORIGIN'] || false,
  });

  await fastify.register(authPlugin);

  if (process.env['NODE_ENV'] === 'development' && process.env['VITE_DEV'] !== 'false') {
    const { setupViteDev } = await import('./vite-dev-integration.ts');
    await setupViteDev(fastify);
  } else {
    const publicDir = isSea()
      ? getPublicDir()
      : path.join(__dirname, '..', 'public');
    await fastify.register(fastifyStatic, { root: publicDir, prefix: '/' });
  }

  fastify.decorate('orchestrator', orchestrator);

  fastify.get('/health', async () => {
    return { status: 'ok', version: PKG_VERSION, timestamp: new Date().toISOString() };
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
  await fastify.register(localLlmRoutes, { prefix: '/api/local-llm' });
  await fastify.register(logsRoutes, { prefix: '/api/logs' });
  await fastify.register(publishRoutes, { prefix: '/api/publish' });
  await fastify.register(chatRoutes);
  await fastify.register(vncRoutes);

  // Start triggers (cron + webhooks) after all routes are registered
  const triggerManager = new TriggerManager();
  await triggerManager.start(orchestrator, fastify);
  orchestrator.triggers.setManager(triggerManager);

  return fastify;
}
