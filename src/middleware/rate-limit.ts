import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * In-memory sliding-window rate limiter.
 * Tracks request timestamps per IP and rejects with 429 when the limit is exceeded.
 */
const buckets = new Map<string, number[]>();

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of buckets) {
    const fresh = timestamps.filter((t) => now - t < 120_000); // keep 2 min max
    if (fresh.length === 0) buckets.delete(key);
    else buckets.set(key, fresh);
  }
}, 5 * 60 * 1000);

export function rateLimitHook(maxAttempts: number, windowMs: number) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const ip = request.ip;
    const now = Date.now();
    const timestamps = buckets.get(ip) ?? [];

    // Keep only timestamps within the window
    const recent = timestamps.filter((t) => now - t < windowMs);

    if (recent.length >= maxAttempts) {
      return reply.status(429).send({ error: 'Too many attempts. Try again later.' });
    }

    recent.push(now);
    buckets.set(ip, recent);
  };
}
