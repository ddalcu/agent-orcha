import * as fs from 'fs';
import type { FastifyPluginAsync } from 'fastify';
import fastifyStatic from '@fastify/static';
import { WebSocketServer, WebSocket } from 'ws';

const NOVNC_PATH = '/usr/share/novnc';
const WEBSOCKIFY_PORT = 6080;

export const vncRoutes: FastifyPluginAsync = async (fastify) => {
  const inContainer = process.env['BROWSER_SANDBOX'] === 'true';
  const hasLocalNoVNC = fs.existsSync(NOVNC_PATH);

  // Check if sandbox container is running externally (local dev mode)
  const sandboxContainerAvailable = async (): Promise<boolean> => {
    if (inContainer) return false;
    try {
      const res = await fetch('http://localhost:9222/json/version');
      return res.ok;
    } catch {
      return false;
    }
  };

  fastify.get('/api/vnc/status', async () => {
    if (inContainer && hasLocalNoVNC) {
      return { enabled: true, mode: 'embedded', url: '/vnc/vnc.html?autoconnect=true&path=websockify' };
    }
    const external = await sandboxContainerAvailable();
    if (external) {
      return { enabled: true, mode: 'external', url: 'http://localhost:6080/vnc.html?autoconnect=true' };
    }
    return { enabled: false };
  });

  // Serve noVNC static files and WebSocket proxy only when running inside Docker
  if (!inContainer || !hasLocalNoVNC) return;

  await fastify.register(fastifyStatic, {
    root: NOVNC_PATH,
    prefix: '/vnc/',
    decorateReply: false,
  });

  fastify.get('/vnc', async (_request, reply) => {
    reply.redirect('/vnc/vnc.html?autoconnect=true&path=websockify');
  });

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
