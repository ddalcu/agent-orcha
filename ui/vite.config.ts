import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'path';

/**
 * Serves chat.html for /chat/* routes in dev mode,
 * mirroring the Fastify server behavior in production.
 */
function chatRoutePlugin(): Plugin {
  return {
    name: 'chat-route',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url && req.url.startsWith('/chat/')) {
          req.url = '/chat.html';
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [chatRoutePlugin(), svelte()],
  build: {
    outDir: resolve(__dirname, '../public'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1100,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        chat: resolve(__dirname, 'chat.html'),
      },
      output: {
        manualChunks: {
          vendor: ['marked', 'dompurify', 'highlight.js'],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
    },
  },
});
