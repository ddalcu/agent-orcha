import { test, expect } from '@playwright/test';
import { authenticate, navigateToLlm } from './helpers';

test.beforeEach(async ({ context, page }) => {
  await authenticate(context);
  await navigateToLlm(page);
});

test.describe('LLM Tab — UI', () => {
  test('tab loads with LLM page content', async ({ page }) => {
    const view = page.locator('.llm-provider-tabs');
    await expect(view).toBeAttached();
  });

  test('header shows LLM Configuration title', async ({ page }) => {
    const heading = page.locator('.view-panel h2');
    await expect(heading).toContainText('LLM Configuration');
  });

  test('refresh button is present', async ({ page }) => {
    const refreshBtn = page.locator('.view-panel button[title="Refresh"]');
    await expect(refreshBtn).toBeAttached();
  });

  test('provider tabs are visible', async ({ page }) => {
    const providerTabs = page.locator('.llm-provider-tabs');
    await expect(providerTabs).toBeAttached();

    // Should have at least the local provider tab
    const tabs = providerTabs.locator('.llm-provider-tab');
    const count = await tabs.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('engine tabs are visible for local provider', async ({ page }) => {
    // Click the Local provider tab first
    await page.locator('.llm-provider-tab', { hasText: 'Local' }).click();

    const engineTabs = page.locator('.llm-engine-tabs');
    await expect(engineTabs).toBeAttached();

    // Should have at least one engine tab (llama-cpp or mlx-serve)
    const tabs = engineTabs.locator('.llm-engine-tab');
    const count = await tabs.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('status bar is present', async ({ page }) => {
    // Click the Local provider tab first
    await page.locator('.llm-provider-tab', { hasText: 'Local' }).click();

    const statusBar = page.locator('.llm-server-panel');
    await expect(statusBar).toBeAttached();
  });

  test('downloaded models section exists', async ({ page }) => {
    // Click the Local provider tab and select a managed engine (llama-cpp or mlx-serve)
    await page.locator('.llm-provider-tab', { hasText: 'Local' }).click();
    // Select a managed engine — "Downloaded Models" only shows for managed engines
    const managedEngine = page.locator('.llm-engine-tab', { hasText: /llama-cpp|mlx-serve/ }).first();
    if (await managedEngine.isVisible()) {
      await managedEngine.click();
      const modelsSection = page.locator('.section-title', { hasText: 'Downloaded Models' });
      await expect(modelsSection).toBeAttached();
    } else {
      test.skip();
    }
  });

  test('HuggingFace browser section exists', async ({ page }) => {
    // Select a managed engine — HuggingFace Browser only shows for managed engines
    await page.locator('.llm-provider-tab', { hasText: 'Local' }).click();
    const managedEngine = page.locator('.llm-engine-tab', { hasText: /llama-cpp|mlx-serve/ }).first();
    if (await managedEngine.isVisible()) {
      await managedEngine.click();
      const hfSection = page.locator('.section-title', { hasText: 'HuggingFace Browser' });
      await expect(hfSection).toBeAttached();

      const searchInput = page.locator('input[placeholder*="Search models"]');
      await expect(searchInput).toBeAttached();

      const searchBtn = page.locator('button', { hasText: 'Search' });
      await expect(searchBtn).toBeAttached();
    } else {
      test.skip();
    }
  });

  test('HuggingFace format select has GGUF and MLX options', async ({ page }) => {
    // Select a managed engine — format select only shows for managed engines
    await page.locator('.llm-provider-tab', { hasText: 'Local' }).click();
    const managedEngine = page.locator('.llm-engine-tab', { hasText: /llama-cpp|mlx-serve/ }).first();
    if (await managedEngine.isVisible()) {
      await managedEngine.click();
      const formatSelect = page.locator('select:has(option[value="gguf"])');
      await expect(formatSelect).toBeAttached();

      const options = formatSelect.locator('option');
      const count = await options.count();
      expect(count).toBeGreaterThanOrEqual(2);

      await expect(options.nth(0)).toHaveText('GGUF');
      await expect(options.nth(1)).toHaveText('MLX');
    } else {
      test.skip();
    }
  });

  test('HuggingFace results area shows placeholder text', async ({ page }) => {
    // Select a managed engine — HuggingFace results only show for managed engines
    await page.locator('.llm-provider-tab', { hasText: 'Local' }).click();
    const managedEngine = page.locator('.llm-engine-tab', { hasText: /llama-cpp|mlx-serve/ }).first();
    if (await managedEngine.isVisible()) {
      await managedEngine.click();
      const hfPlaceholder = page.locator(':text("Search HuggingFace")');
      await expect(hfPlaceholder).toBeAttached();
    } else {
      test.skip();
    }
  });
});

test.describe('LLM Tab — API', () => {
  test('GET /api/local-llm/status returns valid status', async ({ context }) => {
    await authenticate(context);
    const res = await context.request.get('/api/local-llm/status');
    expect(res.ok()).toBeTruthy();

    const status = await res.json();
    expect(status).toBeDefined();
    expect(typeof status).toBe('object');
  });

  test('GET /api/local-llm/models returns an array', async ({ context }) => {
    await authenticate(context);
    const res = await context.request.get('/api/local-llm/models');
    expect(res.ok()).toBeTruthy();

    const models = await res.json();
    expect(Array.isArray(models)).toBe(true);
  });

  test('GET /api/local-llm/engines returns engine information', async ({ context }) => {
    await authenticate(context);
    const res = await context.request.get('/api/local-llm/engines');
    expect(res.ok()).toBeTruthy();

    const engines = await res.json();
    expect(engines).toBeDefined();
    expect(typeof engines).toBe('object');
  });

  test('GET /api/llm/config returns model and embedding configuration', async ({ context }) => {
    await authenticate(context);
    const res = await context.request.get('/api/llm/config');
    expect(res.ok()).toBeTruthy();

    const config = await res.json();
    expect(config).toBeDefined();
    expect(config).toHaveProperty('models');
    expect(config).toHaveProperty('embeddings');
  });
});
