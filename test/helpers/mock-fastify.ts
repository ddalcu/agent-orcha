/**
 * Lightweight Fastify instance builder for route testing.
 * Uses fastify.inject() so no HTTP server is started.
 */
import Fastify from 'fastify';
import type { FastifyPluginAsync } from 'fastify';
import { createMockOrchestrator } from './mock-orchestrator.ts';

export async function createTestApp(
  route: FastifyPluginAsync,
  prefix: string,
  orchestratorOverrides: Record<string, any> = {}
) {
  const app = Fastify({ logger: false });
  const orchestrator = createMockOrchestrator(orchestratorOverrides);

  app.decorate('orchestrator', orchestrator);
  await app.register(route, { prefix });
  await app.ready();

  return { app, orchestrator };
}
