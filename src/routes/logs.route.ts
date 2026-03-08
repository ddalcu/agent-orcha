import type { FastifyPluginAsync } from 'fastify';
import { getRecentLogs, subscribeToLogs, unsubscribeFromLogs, type LogEntry } from '../../lib/logger.ts';

export const logsRoutes: FastifyPluginAsync = async (fastify) => {
  // SSE stream for real-time logs
  fastify.get('/stream', async (request, reply) => {
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');

    // Send recent logs as backfill
    const recent = getRecentLogs(100);
    for (const entry of recent) {
      reply.raw.write(`data: ${JSON.stringify(entry)}\n\n`);
    }

    // Stream new logs as they arrive
    const onLog = (entry: LogEntry) => {
      reply.raw.write(`data: ${JSON.stringify(entry)}\n\n`);
    };

    subscribeToLogs(onLog);

    request.raw.on('close', () => {
      unsubscribeFromLogs(onLog);
      reply.raw.end();
    });
  });
};
