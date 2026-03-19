import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import type { FastifyInstance } from 'fastify';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function setupViteDev(fastify: FastifyInstance): Promise<void> {
  const uiRoot = path.resolve(__dirname, '..', 'ui');

  const vite = await createViteServer({
    configFile: path.resolve(uiRoot, 'vite.config.ts'),
    root: uiRoot,
    plugins: [{
      name: 'disable-proxy',
      config(config) {
        if (config.server?.proxy) {
          delete config.server.proxy;
        }
      },
    }],
    server: {
      middlewareMode: true,
      hmr: { server: fastify.server },
    },
    appType: 'mpa',
  });

  fastify.decorate('viteDevServer', vite);

  // Pass unmatched requests to Vite (Fastify routes like /api/* and /health match first)
  fastify.setNotFoundHandler(async (request, reply) => {
    // Rewrite / to /index.html for Vite's MPA middleware
    if (request.raw.url === '/') {
      request.raw.url = '/index.html';
    }
    return new Promise<void>((resolve) => {
      reply.hijack();
      vite.middlewares(request.raw, reply.raw, () => {
        reply.raw.statusCode = 404;
        reply.raw.end('Not Found');
        resolve();
      });
    });
  });

  fastify.addHook('onClose', async () => {
    await vite.close();
  });
}
