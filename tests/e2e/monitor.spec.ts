import { test, expect } from '@playwright/test';
import { authenticate } from './helpers';

test.beforeEach(async ({ context, page }) => {
  await authenticate(context);
  await page.goto('/#monitor', { waitUntil: 'domcontentloaded' });
  await page.locator('.view-panel').waitFor({ state: 'attached', timeout: 10_000 });
});

test.describe('Monitor Tab', () => {
  test('monitor tab loads with header', async ({ page }) => {
    const header = page.locator('.view-panel h2');
    await expect(header).toContainText('Monitor');
  });

  test('filter controls are present', async ({ page }) => {
    // Status filter (select with "All statuses" option)
    const statusFilter = page.locator('.monitor-filters select', { hasText: 'All statuses' });
    await expect(statusFilter).toBeAttached();

    // Kind filter (select with "All kinds" option)
    const kindFilter = page.locator('.monitor-filters select', { hasText: 'All kinds' });
    await expect(kindFilter).toBeAttached();
  });

  test('refresh button is present', async ({ page }) => {
    const refreshBtn = page.locator('.monitor-filters button[title="Refresh"]');
    await expect(refreshBtn).toBeAttached();
  });

  test('tasks list area exists', async ({ page }) => {
    const container = page.locator('.view-panel');
    await expect(container).toBeAttached();

    // Wait for initial load
    await page.waitForTimeout(2_000);
  });

  test('tasks display or show empty state', async ({ page }) => {
    const container = page.locator('.view-panel');

    // Wait for tasks to load (poll interval is 3s, give it time)
    await page.waitForTimeout(4_000);

    const taskCount = await page.locator('.task-row').count();
    if (taskCount === 0) {
      await expect(container).toContainText('No tasks found');
    } else {
      const firstTask = page.locator('.task-row').first();
      await expect(firstTask).toBeVisible();
    }
  });

  test('task detail area is hidden by default', async ({ page }) => {
    // In the Svelte version, the detail panel is conditionally rendered (not present until a task is selected)
    const detailArea = page.locator('.view-panel .border-t.pt-4');
    await expect(detailArea).not.toBeAttached();
  });

  test('status filter has correct options', async ({ page }) => {
    const statusSelect = page.locator('.monitor-filters select', { hasText: 'All statuses' });
    const options = statusSelect.locator('option');
    const optionTexts = await options.allTextContents();
    expect(optionTexts).toContain('All statuses');
    expect(optionTexts).toContain('Completed');
    expect(optionTexts).toContain('Working');
    expect(optionTexts).toContain('Failed');
  });

  test('kind filter has correct options', async ({ page }) => {
    const kindSelect = page.locator('.monitor-filters select', { hasText: 'All kinds' });
    const options = kindSelect.locator('option');
    const optionTexts = await options.allTextContents();
    expect(optionTexts).toContain('All kinds');
    expect(optionTexts).toContain('Agent');
    expect(optionTexts).toContain('Workflow');
  });
});

test.describe('Monitor API', () => {
  test('GET /api/tasks returns an array', async ({ context }) => {
    await authenticate(context);
    const res = await context.request.get('/api/tasks');
    expect(res.ok()).toBeTruthy();

    const tasks = await res.json();
    expect(Array.isArray(tasks)).toBe(true);
  });

  test('tasks have expected fields when present', async ({ context }) => {
    await authenticate(context);
    const res = await context.request.get('/api/tasks');
    const tasks = await res.json();

    if (tasks.length === 0) return;

    const task = tasks[0];
    expect(task).toHaveProperty('id');
    expect(task).toHaveProperty('status');
    expect(task).toHaveProperty('target');
    expect(task).toHaveProperty('kind');
    expect(task).toHaveProperty('createdAt');
  });

  test('GET /api/tasks supports status filter', async ({ context }) => {
    await authenticate(context);
    const res = await context.request.get('/api/tasks?status=completed');
    expect(res.ok()).toBeTruthy();

    const tasks = await res.json();
    expect(Array.isArray(tasks)).toBe(true);

    // All returned tasks should have completed status
    for (const task of tasks) {
      expect(task.status).toBe('completed');
    }
  });
});
