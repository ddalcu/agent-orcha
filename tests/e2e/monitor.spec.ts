import { test, expect } from '@playwright/test';
import { authenticate } from './helpers';

test.beforeEach(async ({ context, page }) => {
  await authenticate(context);
  await page.goto('/#monitor', { waitUntil: 'domcontentloaded' });
  await page.locator('monitor-view').waitFor({ state: 'attached', timeout: 10_000 });
});

test.describe('Monitor Tab', () => {
  test('monitor tab loads with header', async ({ page }) => {
    const header = page.locator('monitor-view h2');
    await expect(header).toContainText('Monitor');
  });

  test('filter controls are present', async ({ page }) => {
    const statusFilter = page.locator('#filterStatus');
    await expect(statusFilter).toBeAttached();

    const kindFilter = page.locator('#filterKind');
    await expect(kindFilter).toBeAttached();
  });

  test('refresh button is present', async ({ page }) => {
    const refreshBtn = page.locator('#refreshBtn');
    await expect(refreshBtn).toBeAttached();
  });

  test('tasks list container exists', async ({ page }) => {
    const container = page.locator('#tasksListContainer');
    await expect(container).toBeAttached();

    // Wait for initial load
    await page.waitForTimeout(2_000);
  });

  test('tasks display or show empty state', async ({ page }) => {
    const container = page.locator('#tasksListContainer');

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
    const detailArea = page.locator('#taskDetailArea');
    await expect(detailArea).toHaveClass(/hidden/);
  });

  test('status filter has correct options', async ({ page }) => {
    const options = page.locator('#filterStatus option');
    const optionTexts = await options.allTextContents();
    expect(optionTexts).toContain('All statuses');
    expect(optionTexts).toContain('Completed');
    expect(optionTexts).toContain('Working');
    expect(optionTexts).toContain('Failed');
  });

  test('kind filter has correct options', async ({ page }) => {
    const options = page.locator('#filterKind option');
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
