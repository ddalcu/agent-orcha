import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { authPlugin } from '../../src/middleware/auth.ts';

/**
 * Helper: creates a Fastify app with authPlugin + a protected test route.
 */
async function createAuthApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(authPlugin);

  // A protected API route
  app.get('/api/test', async () => ({ data: 'secret' }));

  // A non-API route (simulates static files)
  app.get('/public-page', async () => ({ page: 'home' }));

  // Health endpoint
  app.get('/health', async () => ({ status: 'ok' }));

  await app.ready();
  return app;
}

/**
 * Helper: extracts Set-Cookie value from response headers.
 */
function extractCookie(res: any): string | undefined {
  const raw = res.headers['set-cookie'];
  if (!raw) return undefined;
  const str = Array.isArray(raw) ? raw[0] : raw;
  const match = str.match(/orcha_session=([^;]+)/);
  return match?.[1];
}

describe('authPlugin', () => {
  let app: FastifyInstance;
  let savedPassword: string | undefined;

  beforeEach(() => {
    savedPassword = process.env['AUTH_PASSWORD'];
  });

  afterEach(async () => {
    if (savedPassword !== undefined) {
      process.env['AUTH_PASSWORD'] = savedPassword;
    } else {
      delete process.env['AUTH_PASSWORD'];
    }
    if (app) await app.close();
  });

  // --- Auth disabled ---

  describe('when AUTH_PASSWORD is not set', () => {
    beforeEach(async () => {
      delete process.env['AUTH_PASSWORD'];
      app = await createAuthApp();
    });

    it('should allow API routes without auth', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/test' });
      assert.equal(res.statusCode, 200);
      assert.equal(JSON.parse(res.payload).data, 'secret');
    });

    it('GET /api/auth/check should return required=false', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/auth/check' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.authenticated, true);
      assert.equal(body.required, false);
    });

    it('POST /api/auth/login should return required=false', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: 'anything' },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(JSON.parse(res.payload).required, false);
    });
  });

  // --- Auth enabled ---

  describe('when AUTH_PASSWORD is set', () => {
    beforeEach(async () => {
      process.env['AUTH_PASSWORD'] = 'test-password';
      app = await createAuthApp();
    });

    // -- Unauthenticated requests --

    it('should block API routes without cookie', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/test' });
      assert.equal(res.statusCode, 401);
      assert.equal(JSON.parse(res.payload).error, 'Unauthorized');
    });

    it('should allow /health without auth', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });
      assert.equal(res.statusCode, 200);
    });

    it('should allow non-API routes without auth', async () => {
      const res = await app.inject({ method: 'GET', url: '/public-page' });
      assert.equal(res.statusCode, 200);
      assert.equal(JSON.parse(res.payload).page, 'home');
    });

    it('should allow /api/auth/check without auth', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/auth/check' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.authenticated, false);
      assert.equal(body.required, true);
    });

    it('should allow /api/auth/login without auth', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: 'wrong' },
      });
      // 401 from the login handler (wrong password), not from the hook
      assert.equal(res.statusCode, 401);
      assert.equal(JSON.parse(res.payload).error, 'Invalid password');
    });

    // -- Login --

    it('should reject wrong password', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: 'wrong' },
      });
      assert.equal(res.statusCode, 401);
    });

    it('should reject empty password', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {},
      });
      assert.equal(res.statusCode, 401);
    });

    it('should accept correct password and set cookie', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: 'test-password' },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(JSON.parse(res.payload).authenticated, true);

      const cookie = extractCookie(res);
      assert.ok(cookie, 'should set orcha_session cookie');
      assert.ok(cookie.length > 0);

      // Cookie should be HttpOnly and SameSite=Strict
      const setCookie = res.headers['set-cookie'];
      assert.ok(setCookie.includes('HttpOnly'));
      assert.ok(setCookie.includes('SameSite=Strict'));
    });

    // -- Authenticated requests --

    it('should allow API routes with valid cookie', async () => {
      // Login first
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: 'test-password' },
      });
      const cookie = extractCookie(loginRes);

      // Use cookie to access protected route
      const res = await app.inject({
        method: 'GET',
        url: '/api/test',
        headers: { cookie: `orcha_session=${cookie}` },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(JSON.parse(res.payload).data, 'secret');
    });

    it('/api/auth/check should return authenticated=true with valid cookie', async () => {
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: 'test-password' },
      });
      const cookie = extractCookie(loginRes);

      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/check',
        headers: { cookie: `orcha_session=${cookie}` },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.authenticated, true);
      assert.equal(body.required, true);
    });

    it('should reject an invalid/forged cookie', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/test',
        headers: { cookie: 'orcha_session=forged-token-value' },
      });
      assert.equal(res.statusCode, 401);
    });

    // -- Logout --

    it('should invalidate session on logout', async () => {
      // Login
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: 'test-password' },
      });
      const cookie = extractCookie(loginRes);

      // Logout
      const logoutRes = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { cookie: `orcha_session=${cookie}` },
      });
      assert.equal(logoutRes.statusCode, 200);
      assert.equal(JSON.parse(logoutRes.payload).authenticated, false);

      // Cookie should be cleared (Max-Age=0)
      const setCookie = logoutRes.headers['set-cookie'];
      assert.ok(setCookie.includes('Max-Age=0'));

      // Old cookie should no longer work
      const res = await app.inject({
        method: 'GET',
        url: '/api/test',
        headers: { cookie: `orcha_session=${cookie}` },
      });
      assert.equal(res.statusCode, 401);
    });

    // -- Multiple sessions --

    it('should support multiple independent sessions', async () => {
      // Login twice — two separate sessions
      const login1 = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: 'test-password' },
      });
      const cookie1 = extractCookie(login1);

      const login2 = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: 'test-password' },
      });
      const cookie2 = extractCookie(login2);

      assert.notEqual(cookie1, cookie2);

      // Both should work
      const res1 = await app.inject({
        method: 'GET',
        url: '/api/test',
        headers: { cookie: `orcha_session=${cookie1}` },
      });
      assert.equal(res1.statusCode, 200);

      const res2 = await app.inject({
        method: 'GET',
        url: '/api/test',
        headers: { cookie: `orcha_session=${cookie2}` },
      });
      assert.equal(res2.statusCode, 200);

      // Logging out session 1 should not affect session 2
      await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { cookie: `orcha_session=${cookie1}` },
      });

      const res1After = await app.inject({
        method: 'GET',
        url: '/api/test',
        headers: { cookie: `orcha_session=${cookie1}` },
      });
      assert.equal(res1After.statusCode, 401);

      const res2After = await app.inject({
        method: 'GET',
        url: '/api/test',
        headers: { cookie: `orcha_session=${cookie2}` },
      });
      assert.equal(res2After.statusCode, 200);
    });

    // -- Query string paths --

    it('should protect API routes with query strings', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/test?foo=bar' });
      assert.equal(res.statusCode, 401);
    });
  });
});
