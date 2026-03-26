import * as fs from 'fs';
import type { FastifyPluginAsync } from 'fastify';
import fastifyStatic from '@fastify/static';
import { WebSocketServer, WebSocket } from 'ws';

const NOVNC_PATH = '/usr/share/novnc';
const WEBSOCKIFY_PORT = 6080;

export interface VncRouteDeps {
  existsSync?: (path: string) => boolean;
  WebSocketServerClass?: new (opts: any) => any;
  WebSocketClass?: { new (url: string, opts?: any): any; OPEN?: number };
  staticPlugin?: any;
}

export const vncRoutes: FastifyPluginAsync<VncRouteDeps> = async (fastify, opts) => {
  const _existsSync = opts.existsSync ?? fs.existsSync;
  const _WebSocketServer = opts.WebSocketServerClass ?? WebSocketServer;
  const _WebSocket = opts.WebSocketClass ?? WebSocket;
  const _staticPlugin = opts.staticPlugin ?? fastifyStatic;
  const WS_OPEN = _WebSocket.OPEN ?? 1;

  const inContainer = process.env['BROWSER_SANDBOX'] === 'true';
  const hasLocalNoVNC = _existsSync(NOVNC_PATH);

  // Check if sandbox container is running externally (local dev mode)
  const sandboxContainerAvailable = async (): Promise<boolean> => {
    if (inContainer) return false;
    try {
      const res = await fetch('http://127.0.0.1:9222/json/version');
      return res.ok;
    } catch {
      return false;
    }
  };

  fastify.get('/api/vnc/status', async () => {
    const sandboxInfo = fastify.orchestrator.sandbox.getStatus();

    if (inContainer && hasLocalNoVNC) {
      return { enabled: true, mode: 'embedded', url: '/vnc/vnc.html?autoconnect=true&path=websockify', sandbox: sandboxInfo };
    }
    const external = await sandboxContainerAvailable();
    if (external) {
      return { enabled: true, mode: 'external', url: 'http://localhost:6080/vnc.html?autoconnect=true', sandbox: sandboxInfo };
    }
    return { enabled: false, sandbox: sandboxInfo };
  });

  // Serve noVNC static files and WebSocket proxy only when running inside Docker
  if (!inContainer || !hasLocalNoVNC) return;

  await fastify.register(_staticPlugin, {
    root: NOVNC_PATH,
    prefix: '/vnc/',
    decorateReply: false,
  });

  fastify.get('/vnc', async (_request, reply) => {
    reply.redirect('/vnc/vnc.html?autoconnect=true&path=websockify');
  });

  const wss = new _WebSocketServer({ noServer: true });

  fastify.server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/websockify' && req.url !== '/vnc/websockify') return;

    wss.handleUpgrade(req, socket, head, (clientWs: any) => {
      const targetWs = new _WebSocket(`ws://127.0.0.1:${WEBSOCKIFY_PORT}`, {
        protocol: clientWs.protocol,
      });

      targetWs.on('open', () => {
        clientWs.on('message', (data: any, isBinary: boolean) => {
          if (targetWs.readyState === WS_OPEN) {
            targetWs.send(data, { binary: isBinary });
          }
        });

        targetWs.on('message', (data: any, isBinary: boolean) => {
          if (clientWs.readyState === WS_OPEN) {
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
