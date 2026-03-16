import type { FastifyPluginAsync } from 'fastify';

const HTMLHOST_URL = 'https://htmlhost.jax.workers.dev/store';

interface PublishBody {
  key: string;
  value: string;
}

export const publishRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: PublishBody }>('/', async (request, reply) => {
    const { key, value } = request.body || {};

    if (!key || !value) {
      return reply.status(400).send({ error: 'Missing key or value' });
    }

    const res = await fetch(HTMLHOST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value }),
    });

    if (!res.ok) {
      const text = await res.text();
      return reply.status(res.status).send({ error: text || `HTTP ${res.status}` });
    }

    const data = await res.json();
    return data;
  });
};
