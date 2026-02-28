import * as fs from 'fs';
import type { FastifyPluginAsync } from 'fastify';
import fastifyStatic from '@fastify/static';
import { WebSocketServer, WebSocket } from 'ws';

const NOVNC_PATH = '/usr/share/novnc';
const WEBSOCKIFY_PORT = 6080;

export const vncRoutes: FastifyPluginAsync = async (fastify) => {
  const enabled = process.env['BROWSER_SANDBOX'] === 'true';

  fastify.get('/api/vnc/status', async () => ({ enabled }));

  if (!enabled || !fs.existsSync(NOVNC_PATH)) return;

  // Serve noVNC static files under /vnc/
  await fastify.register(fastifyStatic, {
    root: NOVNC_PATH,
    prefix: '/vnc/',
    decorateReply: false,
  });

  // Redirect /vnc to the viewer
  fastify.get('/vnc', async (_request, reply) => {
    reply.redirect('/vnc/vnc.html?autoconnect=true&path=websockify');
  });

  // WebSocket proxy for VNC
  const wss = new WebSocketServer({ noServer: true });

  fastify.server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/websockify') return;

    wss.handleUpgrade(req, socket, head, (clientWs) => {
      const targetWs = new WebSocket(`ws://localhost:${WEBSOCKIFY_PORT}`, {
        protocol: clientWs.protocol,
      });

      targetWs.on('open', () => {
        clientWs.on('message', (data, isBinary) => {
          if (targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(data, { binary: isBinary });
          }
        });

        targetWs.on('message', (data, isBinary) => {
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(data, { binary: isBinary });
          }
        });
      });

      clientWs.on('close', () => targetWs.close());
      targetWs.on('close', () => clientWs.close());
      clientWs.on('error', () => targetWs.close());
      targetWs.on('error', () => clientWs.close());
    });
  });
};
