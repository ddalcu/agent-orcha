import { test, expect } from '@playwright/test';
import { authenticate } from './helpers';

test.beforeEach(async ({ context, page }) => {
  await authenticate(context);
  await page.goto('/#mcp', { waitUntil: 'domcontentloaded' });
  await page.locator('.mcp-tabs').waitFor({ state: 'attached', timeout: 10_000 });
});

test.describe('MCP Tab', () => {
  test('MCP tab loads with tabs for MCP Servers and Internal Functions', async ({ page }) => {
    const mcpBtn = page.locator('.mcp-tab', { hasText: 'MCP Servers' });
    await expect(mcpBtn).toBeAttached();
    await expect(mcpBtn).toContainText('MCP Servers');

    const funcBtn = page.locator('.mcp-tab', { hasText: 'Internal Functions' });
    await expect(funcBtn).toBeAttached();
    await expect(funcBtn).toContainText('Internal Functions');
  });

  test('MCP Servers tab is active by default', async ({ page }) => {
    const mcpBtn = page.locator('.mcp-tab', { hasText: 'MCP Servers' });
    await expect(mcpBtn).toHaveClass(/active/);
  });

  test('list container loads content', async ({ page }) => {
    const container = page.locator('.view-panel');
    await expect(container).toBeAttached();

    // Wait for loading to finish
    await page.waitForFunction(
      () => {
        const el = document.querySelector('.view-panel');
        return el && !el.textContent?.includes('Loading...');
      },
      null,
      { timeout: 15_000 },
    );
  });

  test('MCP servers display or show empty state', async ({ page }) => {
    const container = page.locator('.view-panel');

    // Wait for loading
    await page.waitForFunction(
      () => {
        const el = document.querySelector('.view-panel');
        return el && !el.textContent?.includes('Loading...');
      },
      null,
      { timeout: 15_000 },
    );

    const accordionCount = await page.locator('.mcp-accordion').count();
    if (accordionCount === 0) {
      await expect(container).toContainText('No servers configured');
    } else {
      const firstHeader = page.locator('.mcp-accordion-header').first();
      await expect(firstHeader).toBeVisible();
    }
  });

  test('switching to Internal Functions tab works', async ({ page }) => {
    const funcBtn = page.locator('.mcp-tab', { hasText: 'Internal Functions' });
    await funcBtn.click();
    await expect(funcBtn).toHaveClass(/active/);

    // MCP button should no longer be active
    const mcpBtn = page.locator('.mcp-tab', { hasText: 'MCP Servers' });
    await expect(mcpBtn).not.toHaveClass(/active/);

    // Wait for loading
    await page.waitForFunction(
      () => {
        const el = document.querySelector('.view-panel');
        return el && !el.textContent?.includes('Loading...');
      },
      null,
      { timeout: 15_000 },
    );
  });

  test('execution area is hidden by default', async ({ page }) => {
    // In the Svelte version, the execution area is conditionally rendered (not present when no item selected)
    const execArea = page.locator('.border-t.pt-4');
    await expect(execArea).not.toBeAttached();
  });
});

test.describe('MCP API', () => {
  test('GET /api/mcp/servers returns an array', async ({ context }) => {
    await authenticate(context);
    const res = await context.request.get('/api/mcp/servers');
    expect(res.ok()).toBeTruthy();

    const servers = await res.json();
    expect(Array.isArray(servers)).toBe(true);
  });

  test('MCP servers have expected fields when present', async ({ context }) => {
    await authenticate(context);
    const res = await context.request.get('/api/mcp/servers');
    const servers = await res.json();

    if (servers.length === 0) return;

    const server = servers[0];
    expect(server).toHaveProperty('name');
    expect(typeof server.name).toBe('string');
    expect(server).toHaveProperty('transport');
  });
});
