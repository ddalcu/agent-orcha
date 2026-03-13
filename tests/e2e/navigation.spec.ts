import { test, expect } from '@playwright/test';
import { authenticate } from './helpers';

const TABS = [
  { id: 'agents', label: 'Agents' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'graph', label: 'Graph' },
  { id: 'mcp', label: 'MCP' },
  { id: 'monitor', label: 'Monitor' },
  { id: 'llm', label: 'LLM' },
  { id: 'ide', label: 'IDE' },
];

const VIEW_TAGS: Record<string, string> = {
  agents: 'agents-view',
  knowledge: 'knowledge-view',
  graph: 'graph-view',
  mcp: 'mcp-view',
  monitor: 'monitor-view',
  llm: 'local-llm-view',
  ide: 'ide-view',
};

test.beforeEach(async ({ context, page }) => {
  await authenticate(context);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('app-root').waitFor({ state: 'attached', timeout: 10_000 });
});

test.describe('Navigation', () => {
  test('app loads successfully', async ({ page }) => {
    const appRoot = page.locator('app-root');
    await expect(appRoot).toBeAttached();

    // The main app shell should be present
    const shell = page.locator('.app-shell');
    await expect(shell).toBeVisible();
  });

  test('logo and brand are visible', async ({ page }) => {
    const logo = page.locator('.sidebar-logo');
    await expect(logo).toBeAttached();

    const brand = page.locator('.sidebar-brand');
    await expect(brand).toContainText('Agent Orcha');
  });

  test('all 7 navigation tabs are visible', async ({ page }) => {
    for (const tab of TABS) {
      const btn = page.locator(`.tab-btn[data-tab="${tab.id}"]`);
      await expect(btn).toBeAttached();
      await expect(btn).toContainText(tab.label);
    }
  });

  test('clicking each tab switches to the correct view', async ({ page }) => {
    for (const tab of TABS) {
      const btn = page.locator(`.tab-btn[data-tab="${tab.id}"]`);
      await btn.click();

      const viewTag = VIEW_TAGS[tab.id];
      const view = page.locator(viewTag);
      await expect(view).toBeAttached({ timeout: 10_000 });
    }
  });

  test('URL hash updates when switching tabs', async ({ page }) => {
    for (const tab of TABS) {
      const btn = page.locator(`.tab-btn[data-tab="${tab.id}"]`);
      await btn.click();

      // Wait for hash to update
      await page.waitForFunction(
        (expected) => window.location.hash === `#${expected}`,
        tab.id,
        { timeout: 5_000 },
      );

      const hash = await page.evaluate(() => window.location.hash);
      expect(hash).toBe(`#${tab.id}`);
    }
  });

  test('browser back/forward navigation works', async ({ page }) => {
    // Navigate to agents first (default), then knowledge, then mcp
    await page.locator('.tab-btn[data-tab="knowledge"]').click();
    await page.locator('knowledge-view').waitFor({ state: 'attached', timeout: 10_000 });

    await page.locator('.tab-btn[data-tab="mcp"]').click();
    await page.locator('mcp-view').waitFor({ state: 'attached', timeout: 10_000 });

    // Go back — should return to knowledge
    await page.goBack();
    await page.waitForFunction(() => window.location.hash === '#knowledge', null, { timeout: 5_000 });
    await expect(page.locator('knowledge-view')).toBeAttached({ timeout: 10_000 });

    // Go forward — should return to mcp
    await page.goForward();
    await page.waitForFunction(() => window.location.hash === '#mcp', null, { timeout: 5_000 });
    await expect(page.locator('mcp-view')).toBeAttached({ timeout: 10_000 });
  });

  test('default tab is agents', async ({ page }) => {
    // Navigate without a hash
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.locator('app-root').waitFor({ state: 'attached', timeout: 10_000 });

    // The agents view should be loaded (default tab)
    await expect(page.locator('agents-view')).toBeAttached({ timeout: 10_000 });
  });

  test('navigating directly via hash loads the correct tab', async ({ page }) => {
    await page.goto('/#monitor', { waitUntil: 'domcontentloaded' });
    await page.locator('app-root').waitFor({ state: 'attached', timeout: 10_000 });

    await expect(page.locator('monitor-view')).toBeAttached({ timeout: 10_000 });
  });

  test('active tab button has active class', async ({ page }) => {
    await page.locator('.tab-btn[data-tab="ide"]').click();
    await page.locator('ide-view').waitFor({ state: 'attached', timeout: 10_000 });

    const activeBtn = page.locator('.tab-btn.active[data-tab="ide"]');
    await expect(activeBtn).toBeAttached();

    // Other tabs should not have active class
    const inactiveBtn = page.locator('.tab-btn.active[data-tab="agents"]');
    await expect(inactiveBtn).not.toBeAttached();
  });
});
