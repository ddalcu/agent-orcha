import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * In-memory sliding-window rate limiter.
 * Tracks request timestamps per IP and rejects with 429 when the limit is exceeded.
 * Each call creates an independent limiter with its own state.
 */
export function rateLimitHook(maxAttempts: number, windowMs: number) {
  const buckets = new Map<string, number[]>();

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
