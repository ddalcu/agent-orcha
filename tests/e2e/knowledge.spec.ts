import { test, expect } from '@playwright/test';
import { authenticate } from './helpers';

test.beforeEach(async ({ context, page }) => {
  await authenticate(context);
  await page.goto('/#knowledge', { waitUntil: 'domcontentloaded' });
  await page.locator('knowledge-view').waitFor({ state: 'attached', timeout: 10_000 });
});

test.describe('Knowledge Tab', () => {
  test('knowledge tab loads with the sidebar and detail layout', async ({ page }) => {
    const shell = page.locator('.kb-shell');
    await expect(shell).toBeVisible({ timeout: 10_000 });
  });

  test('knowledge sidebar with store cards is present', async ({ page }) => {
    const sidebar = page.locator('#kbSidebar');
    await expect(sidebar).toBeAttached();

    // Section title should say "Stores"
    const title = page.locator('.section-title');
    await expect(title).toContainText('Stores');
  });

  test('knowledge cards container exists', async ({ page }) => {
    const cards = page.locator('#knowledgeCards');
    await expect(cards).toBeAttached();

    // Wait for loading to finish (spinner replaced by content or empty state)
    await page.waitForFunction(
      () => {
        const el = document.querySelector('#knowledgeCards');
        return el && !el.textContent?.includes('Loading...');
      },
      null,
      { timeout: 15_000 },
    );
  });

  test('knowledge detail area shows placeholder when nothing selected', async ({ page }) => {
    // Wait for cards to load
    await page.waitForFunction(
      () => {
        const el = document.querySelector('#knowledgeCards');
        return el && !el.textContent?.includes('Loading...');
      },
      null,
      { timeout: 15_000 },
    );

    const detail = page.locator('#knowledgeDetail');
    await expect(detail).toBeAttached();
    await expect(detail).toContainText('Select a knowledge store');
  });

  test('refresh button is present', async ({ page }) => {
    const refreshBtn = page.locator('#refreshListBtn');
    await expect(refreshBtn).toBeAttached();
  });

  test('knowledge stores display or show empty state', async ({ page }) => {
    const cards = page.locator('#knowledgeCards');

    // Wait for loading to finish
    await page.waitForFunction(
      () => {
        const el = document.querySelector('#knowledgeCards');
        return el && !el.textContent?.includes('Loading...');
      },
      null,
      { timeout: 15_000 },
    );

    const cardCount = await page.locator('.knowledge-card').count();
    if (cardCount === 0) {
      // Empty state
      await expect(cards).toContainText('No knowledge stores configured');
    } else {
      // At least one card should have a name
      const firstCard = page.locator('.knowledge-card').first();
      await expect(firstCard).toBeVisible();
    }
  });
});

test.describe('Knowledge API', () => {
  test('GET /api/knowledge returns an array', async ({ context }) => {
    await authenticate(context);
    const res = await context.request.get('/api/knowledge');
    expect(res.ok()).toBeTruthy();

    const stores = await res.json();
    expect(Array.isArray(stores)).toBe(true);
  });

  test('knowledge stores have expected fields when present', async ({ context }) => {
    await authenticate(context);
    const res = await context.request.get('/api/knowledge');
    const stores = await res.json();

    if (stores.length === 0) return;

    const store = stores[0];
    expect(store).toHaveProperty('name');
    expect(typeof store.name).toBe('string');
    expect(store).toHaveProperty('status');
  });
});
