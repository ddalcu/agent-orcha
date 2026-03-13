import { test, expect } from '@playwright/test';
import { authenticate, navigateToLlm } from './helpers';

test.beforeEach(async ({ context, page }) => {
  await authenticate(context);
  await navigateToLlm(page);
});

test.describe('LLM Tab — UI', () => {
  test('tab loads with LocalLlmView component', async ({ page }) => {
    const view = page.locator('local-llm-view');
    await expect(view).toBeAttached();
  });

  test('header shows LLM Configuration title', async ({ page }) => {
    const heading = page.locator('local-llm-view h2');
    await expect(heading).toContainText('LLM Configuration');
  });

  test('refresh button is present', async ({ page }) => {
    const refreshBtn = page.locator('#refreshBtn');
    await expect(refreshBtn).toBeAttached();
  });

  test('provider tabs are visible', async ({ page }) => {
    const providerTabs = page.locator('#providerTabs');
    await expect(providerTabs).toBeAttached();

    // Should have at least the local provider tab
    const tabs = providerTabs.locator('.llm-provider-tab, button');
    const count = await tabs.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('engine tabs are visible for local provider', async ({ page }) => {
    const engineTabs = page.locator('#engineTabs');
    await expect(engineTabs).toBeAttached();

    // Should have at least one engine tab (llama-cpp or mlx-serve)
    const tabs = engineTabs.locator('.llm-engine-tab, button');
    const count = await tabs.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('status bar is present', async ({ page }) => {
    const statusBar = page.locator('#statusBar');
    await expect(statusBar).toBeAttached();
  });

  test('downloaded models section exists', async ({ page }) => {
    const modelsSection = page.locator('#managedModelsSection');
    await expect(modelsSection).toBeAttached();

    const modelsGrid = page.locator('#modelsGrid');
    await expect(modelsGrid).toBeAttached();
  });

  test('HuggingFace browser section exists', async ({ page }) => {
    const hfSection = page.locator('#hfSection');
    await expect(hfSection).toBeAttached();

    const searchInput = page.locator('#hfSearchInput');
    await expect(searchInput).toBeAttached();

    const searchBtn = page.locator('#hfSearchBtn');
    await expect(searchBtn).toBeAttached();
    await expect(searchBtn).toContainText('Search');
  });

  test('HuggingFace format select has GGUF and MLX options', async ({ page }) => {
    const formatSelect = page.locator('#hfFormatSelect');
    await expect(formatSelect).toBeAttached();

    const options = formatSelect.locator('option');
    const count = await options.count();
    expect(count).toBeGreaterThanOrEqual(2);

    await expect(options.nth(0)).toHaveText('GGUF');
    await expect(options.nth(1)).toHaveText('MLX');
  });

  test('HuggingFace results area shows placeholder text', async ({ page }) => {
    const hfResults = page.locator('#hfResults');
    await expect(hfResults).toBeAttached();
    await expect(hfResults).toContainText('Search HuggingFace');
  });

  test('active downloads area exists', async ({ page }) => {
    const activeDownloads = page.locator('#activeDownloads');
    await expect(activeDownloads).toBeAttached();
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
