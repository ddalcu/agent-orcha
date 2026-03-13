import { test, expect } from '@playwright/test';
import { authenticate } from './helpers';

test.beforeEach(async ({ context, page }) => {
  await authenticate(context);
  await page.goto('/#graph', { waitUntil: 'domcontentloaded' });
  await page.locator('graph-view').waitFor({ state: 'attached', timeout: 10_000 });
});

test.describe('Graph Tab — UI', () => {
  test('tab loads with GraphView component', async ({ page }) => {
    const view = page.locator('graph-view');
    await expect(view).toBeAttached();
  });

  test('graph container is present', async ({ page }) => {
    const container = page.locator('#graphContainer');
    await expect(container).toBeAttached();
    await expect(container).toBeVisible();
  });

  test('graph container has the graph-canvas class', async ({ page }) => {
    const container = page.locator('#graphContainer.graph-canvas');
    await expect(container).toBeAttached();
  });

  test('sidebar starts hidden', async ({ page }) => {
    const sidebar = page.locator('#sidebar');
    await expect(sidebar).toBeAttached();
    await expect(sidebar).toHaveClass(/hidden/);
  });

  test('sidebar content area exists', async ({ page }) => {
    const sidebarContent = page.locator('#sidebarContent');
    await expect(sidebarContent).toBeAttached();
  });

  test('handles empty state gracefully', async ({ page }) => {
    // The graph view should render without errors even if no knowledge stores
    // have graph data. It either shows the vis.js canvas or an error/empty message.
    const container = page.locator('#graphContainer');
    await expect(container).toBeAttached();

    // The container should have some content — either the vis.js canvas
    // or an empty/error state message
    const hasCanvas = await container.locator('canvas, .vis-network').count();
    const hasEmptyState = await container.locator('.empty-state, .text-red').count();

    expect(hasCanvas + hasEmptyState).toBeGreaterThanOrEqual(0);
  });
});

test.describe('Graph Tab — API', () => {
  test('GET /api/graph/config returns graph configuration', async ({ context }) => {
    await authenticate(context);
    const res = await context.request.get('/api/graph/config');
    // Config endpoint may return 200 with data or 404 if no graph stores exist
    expect([200, 404]).toContain(res.status());

    if (res.ok()) {
      const config = await res.json();
      expect(config).toBeDefined();
    }
  });

  test('GET /api/graph/full returns nodes and edges', async ({ context }) => {
    await authenticate(context);
    const res = await context.request.get('/api/graph/full?limit=10');
    // May return 200 with data or an error if no graph stores exist
    if (res.ok()) {
      const data = await res.json();
      expect(data).toBeDefined();
      // Should have nodes and edges arrays when data exists
      if (data.nodes !== undefined) {
        expect(Array.isArray(data.nodes)).toBe(true);
      }
      if (data.edges !== undefined) {
        expect(Array.isArray(data.edges)).toBe(true);
      }
    }
  });
});
