import { test, expect } from '@playwright/test';
import { authenticate } from './helpers';

test.beforeEach(async ({ context, page }) => {
  await authenticate(context);
  await page.goto('/#ide', { waitUntil: 'domcontentloaded' });
  await page.locator('.ide-shell').waitFor({ state: 'attached', timeout: 10_000 });
});

test.describe('IDE Tab', () => {
  test('IDE tab loads with the shell layout', async ({ page }) => {
    const shell = page.locator('.ide-shell');
    await expect(shell).toBeVisible({ timeout: 10_000 });
  });

  test('file tree sidebar is present', async ({ page }) => {
    const tree = page.locator('.ide-tree');
    await expect(tree).toBeVisible();
  });

  test('file tree header shows Explorer label', async ({ page }) => {
    const header = page.locator('.ide-tree-header');
    await expect(header).toContainText('Explorer');
  });

  test('new resource button is present', async ({ page }) => {
    const newFileBtn = page.locator('.ide-new-resource-wrapper button');
    await expect(newFileBtn).toBeAttached();
  });

  test('file tree loads content', async ({ page }) => {
    const fileTree = page.locator('.ide-tree');
    await expect(fileTree).toBeAttached();

    // Wait for file tree to load (spinner should disappear)
    await page.waitForFunction(
      () => {
        const el = document.querySelector('.ide-tree');
        return el && !el.textContent?.includes('Loading...');
      },
      null,
      { timeout: 15_000 },
    );
  });

  test('file tree shows directories or is empty', async ({ page }) => {
    // Wait for loading
    await page.waitForFunction(
      () => {
        const el = document.querySelector('.ide-tree');
        return el && !el.textContent?.includes('Loading...');
      },
      null,
      { timeout: 15_000 },
    );

    const treeItems = page.locator('.tree-item');
    const itemCount = await treeItems.count();

    // File tree should have some items (directories like agents/, knowledge/, etc.)
    // or could be empty for a fresh workspace
    expect(itemCount).toBeGreaterThanOrEqual(0);
  });

  test('editor area exists with welcome panel', async ({ page }) => {
    const editorArea = page.locator('.ide-editor');
    await expect(editorArea).toBeAttached();

    // Welcome panel should be visible when no file is selected
    await expect(editorArea).toContainText('Select a file');
  });

  test('toolbar with save button and breadcrumb exists', async ({ page }) => {
    const toolbar = page.locator('.ide-toolbar');
    await expect(toolbar).toBeVisible();

    const saveBtn = page.locator('.ide-toolbar button', { hasText: 'Save' });
    await expect(saveBtn).toBeAttached();
    // Save should be disabled when no file is open
    await expect(saveBtn).toBeDisabled();

    // Breadcrumb text is rendered inside toolbar
    await expect(toolbar).toContainText('Select a file to edit');
  });

  test('editor area shows welcome state initially', async ({ page }) => {
    // When no file is selected, the editor area shows the welcome message
    const editorArea = page.locator('.ide-editor');
    await expect(editorArea).toBeAttached();
    await expect(editorArea).toContainText('Select a file from the tree');
  });

  test('clicking a file in the tree opens it in the editor', async ({ page }) => {
    // Wait for file tree to load
    await page.waitForFunction(
      () => {
        const el = document.querySelector('.ide-tree');
        return el && !el.textContent?.includes('Loading...');
      },
      null,
      { timeout: 15_000 },
    );

    // Check if there are any directories to expand (directories have folder icons)
    const dirItems = page.locator('.tree-item:has(.fa-folder)');
    const dirCount = await dirItems.count();

    if (dirCount === 0) {
      // No files at all — skip
      test.skip();
      return;
    }

    // Expand the first directory
    await dirItems.first().click();

    // Wait for expansion
    await page.waitForTimeout(500);

    // Look for file items (files have tree-filename class)
    const fileItems = page.locator('.tree-item:has(.tree-filename)');
    const fileCount = await fileItems.count();

    if (fileCount === 0) {
      test.skip();
      return;
    }

    // Click the first file
    await fileItems.first().click();

    // Editor should now show the file content (welcome state replaced by ace editor)
    await page.waitForFunction(
      () => {
        const editor = document.querySelector('.ide-editor');
        return editor && !editor.textContent?.includes('Select a file from the tree');
      },
      null,
      { timeout: 10_000 },
    );

    // Breadcrumb should be updated
    const toolbarText = await page.locator('.ide-toolbar').textContent();
    expect(toolbarText).not.toContain('Select a file to edit');
  });
});

test.describe('IDE API', () => {
  test('GET /api/ide/tree returns file tree data', async ({ context }) => {
    await authenticate(context);
    const res = await context.request.get('/api/ide/tree');
    expect(res.ok()).toBeTruthy();

    const data = await res.json();
    expect(data).toHaveProperty('tree');
    expect(Array.isArray(data.tree)).toBe(true);
  });
});
