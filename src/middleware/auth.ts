import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { randomBytes, timingSafeEqual } from 'crypto';

const COOKIE_NAME = 'orcha_session';
const MAX_AGE = 86400;

// --- Session store ---
const sessions = new Set<string>();

function createSession(): string {
  const token = randomBytes(32).toString('hex');
  sessions.add(token);
  return token;
}

function isValidSession(token: string): boolean {
  return sessions.has(token);
}

function destroySession(token: string): void {
  sessions.delete(token);
}

// --- Cookie helpers ---
function parseCookies(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const cookies: Record<string, string> = {};
  for (const pair of raw.split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    cookies[pair.substring(0, idx).trim()] = pair.substring(idx + 1).trim();
  }
  return cookies;
}

function getSessionToken(request: FastifyRequest): string | undefined {
  return parseCookies(request.headers.cookie)[COOKIE_NAME];
}

function setSessionCookie(reply: FastifyReply, token: string): void {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${MAX_AGE}`,
  ];
  if (process.env['NODE_ENV'] === 'production') {
    parts.push('Secure');
  }
  reply.header('set-cookie', parts.join('; '));
}

function clearSessionCookie(reply: FastifyReply): void {
  reply.header('set-cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

function isAuthEnabled(): boolean {
  return !!process.env['AUTH_PASSWORD'];
}

function verifyPassword(input: string): boolean {
  const expected = process.env['AUTH_PASSWORD'];
  if (!expected) return false;
  try {
    return timingSafeEqual(Buffer.from(input), Buffer.from(expected));
  } catch {
    return false;
  }
}

const PUBLIC_PATHS = new Set(['/api/auth/login', '/api/auth/check', '/api/auth/logout']);

const PROTECTED_NON_API = ['/vnc', '/websockify'];

function isPublicRequest(url: string): boolean {
  const path = url.split('?')[0] ?? url;
  if (path === '/health' || PUBLIC_PATHS.has(path) || path.startsWith('/api/chat/')) return true;
  if (PROTECTED_NON_API.some((p) => path === p || path.startsWith(p + '/'))) return false;
  return !path.startsWith('/api/');
}

// --- Plugin (fp breaks encapsulation so the hook applies globally) ---
const authPluginImpl: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onRequest', async (request, reply) => {
    if (!isAuthEnabled()) return;
    if (isPublicRequest(request.url)) return;

    const token = getSessionToken(request);
    if (token && isValidSession(token)) return;

    reply.status(401).send({ error: 'Unauthorized' });
  });

  fastify.get('/api/auth/check', async (request) => {
    if (!isAuthEnabled()) return { authenticated: true, required: false };
    const token = getSessionToken(request);
    return { authenticated: !!token && isValidSession(token), required: true };
  });

  fastify.post<{ Body: { password?: string } }>('/api/auth/login', async (request, reply) => {
    if (!isAuthEnabled()) return { authenticated: true, required: false };

    const { password } = request.body ?? {};
    if (!password || !verifyPassword(password)) {
      return reply.status(401).send({ error: 'Invalid password' });
    }

    const token = createSession();
    setSessionCookie(reply, token);
    return { authenticated: true };
  });

  fastify.post('/api/auth/logout', async (request, reply) => {
    const token = getSessionToken(request);
    if (token) destroySession(token);
    clearSessionCookie(reply);
    return { authenticated: false };
  });
};

export const authPlugin = fp(authPluginImpl);
