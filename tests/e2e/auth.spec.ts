import { test, expect } from '@playwright/test';

test.describe('Authentication', () => {
  test('auth check endpoint works', async ({ request }) => {
    const res = await request.get('/api/auth/check');
    expect(res.ok()).toBeTruthy();

    const body = await res.json();
    expect(body).toHaveProperty('required');
    expect(typeof body.required).toBe('boolean');
    expect(body).toHaveProperty('authenticated');
    expect(typeof body.authenticated).toBe('boolean');
  });

  test('login form appears when auth is required', async ({ page, request }) => {
    const check = await request.get('/api/auth/check');
    const data = await check.json();

    if (!data.required) {
      test.skip();
      return;
    }

    // Use a fresh context without prior auth cookies
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.locator('.app-shell').waitFor({ state: 'attached', timeout: 10_000 });

    // Auth overlay should appear
    const overlay = page.locator('.auth-overlay');
    await expect(overlay).toBeVisible({ timeout: 10_000 });

    // Password input and submit button should be present
    const passwordInput = page.locator('.auth-card input[type="password"]');
    await expect(passwordInput).toBeVisible();

    const submitBtn = page.locator('.auth-card button.btn');
    await expect(submitBtn).toBeVisible();
    await expect(submitBtn).toContainText('Sign In');
  });

  test('login with correct password works', async ({ page, request }) => {
    const check = await request.get('/api/auth/check');
    const data = await check.json();

    if (!data.required) {
      test.skip();
      return;
    }

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.locator('.app-shell').waitFor({ state: 'attached', timeout: 10_000 });

    // Wait for the login form
    await page.locator('.auth-overlay').waitFor({ state: 'visible', timeout: 10_000 });

    const password = process.env.AUTH_PASSWORD || 'ao2026';
    await page.locator('.auth-card input[type="password"]').fill(password);
    await page.locator('.auth-card button.btn').click();

    // Auth overlay should disappear
    await expect(page.locator('.auth-overlay')).not.toBeAttached({ timeout: 10_000 });
  });

  test('login with wrong password shows error', async ({ page, request }) => {
    const check = await request.get('/api/auth/check');
    const data = await check.json();

    if (!data.required) {
      test.skip();
      return;
    }

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.locator('.app-shell').waitFor({ state: 'attached', timeout: 10_000 });

    await page.locator('.auth-overlay').waitFor({ state: 'visible', timeout: 10_000 });

    await page.locator('.auth-card input[type="password"]').fill('wrong-password-12345');
    await page.locator('.auth-card button.btn').click();

    // Error message should appear
    const errorDiv = page.locator('.auth-error');
    await expect(errorDiv).toContainText('Invalid password', { timeout: 10_000 });
    await expect(errorDiv).toHaveClass(/visible/);

    // Auth overlay should still be visible
    await expect(page.locator('.auth-overlay')).toBeVisible();
  });

  test('logout button appears when authenticated', async ({ page, request }) => {
    const check = await request.get('/api/auth/check');
    const data = await check.json();

    if (!data.required) {
      test.skip();
      return;
    }

    // Login first
    const password = process.env.AUTH_PASSWORD || 'ao2026';
    await request.post('/api/auth/login', { data: { password } });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.locator('.app-shell').waitFor({ state: 'attached', timeout: 10_000 });

    const logoutBtn = page.locator('button[title="Logout"]');
    await expect(logoutBtn).toBeVisible({ timeout: 10_000 });
  });

  test('login via API and verify authenticated state', async ({ request }) => {
    const check = await request.get('/api/auth/check');
    const data = await check.json();

    if (!data.required) {
      test.skip();
      return;
    }

    const password = process.env.AUTH_PASSWORD || 'ao2026';
    const loginRes = await request.post('/api/auth/login', { data: { password } });
    expect(loginRes.ok()).toBeTruthy();

    // Verify authenticated
    const recheck = await request.get('/api/auth/check');
    const recheckData = await recheck.json();
    expect(recheckData.authenticated).toBe(true);
  });
});
