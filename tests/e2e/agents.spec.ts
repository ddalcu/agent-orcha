import { test, expect } from '@playwright/test';
import { authenticate } from './helpers';

test.beforeEach(async ({ context, page }) => {
  await authenticate(context);
  await page.goto('/#agents', { waitUntil: 'domcontentloaded' });
  await page.locator('.agent-shell').waitFor({ state: 'attached', timeout: 10_000 });
});

test.describe('Agents Tab', () => {
  test('agents tab loads and shows the chat shell', async ({ page }) => {
    // The agents view should have the agent-shell container
    const shell = page.locator('.agent-shell');
    await expect(shell).toBeVisible({ timeout: 10_000 });
  });

  test('sidebar with session list is present', async ({ page }) => {
    const sidebar = page.locator('.agent-sidebar');
    await expect(sidebar).toBeAttached();
  });

  test('new chat button is present', async ({ page }) => {
    const newChatBtn = page.locator('.new-chat-btn');
    await expect(newChatBtn).toBeAttached();
    await expect(newChatBtn).toContainText('New chat');
  });

  test('chat input area exists', async ({ page }) => {
    const chatInput = page.locator('.chat-input-wrap textarea');
    await expect(chatInput).toBeAttached();

    const sendBtn = page.locator('.send-btn');
    await expect(sendBtn).toBeAttached();
  });

  test('chat messages container exists', async ({ page }) => {
    const messages = page.locator('.chat-messages');
    await expect(messages).toBeAttached();
  });

  test('new agent button is present in sidebar', async ({ page }) => {
    const newAgentBtn = page.locator('.sidebar-secondary-btn');
    await expect(newAgentBtn).toBeAttached();
    await expect(newAgentBtn).toContainText('New agent');
  });
});

test.describe('Agents API', () => {
  test('GET /api/agents returns an array', async ({ context }) => {
    await authenticate(context);
    const res = await context.request.get('/api/agents');
    expect(res.ok()).toBeTruthy();

    const agents = await res.json();
    expect(Array.isArray(agents)).toBe(true);
  });

  test('GET /api/agents returns agents with expected fields', async ({ context }) => {
    await authenticate(context);
    const res = await context.request.get('/api/agents');
    const agents = await res.json();

    if (agents.length === 0) {
      // No agents configured — still valid
      return;
    }

    const agent = agents[0];
    expect(agent).toHaveProperty('name');
    expect(typeof agent.name).toBe('string');
  });

  test('GET /api/agents/:name returns agent details when agents exist', async ({ context }) => {
    await authenticate(context);
    const listRes = await context.request.get('/api/agents');
    const agents = await listRes.json();

    if (agents.length === 0) {
      test.skip();
      return;
    }

    const agentName = agents[0].name;
    const detailRes = await context.request.get(`/api/agents/${agentName}`);
    expect(detailRes.ok()).toBeTruthy();

    const detail = await detailRes.json();
    expect(detail.name).toBe(agentName);
  });

  test('GET /api/agents/:name returns 404 for nonexistent agent', async ({ context }) => {
    await authenticate(context);
    const res = await context.request.get('/api/agents/nonexistent-agent-xyz-12345');
    expect(res.status()).toBe(404);
  });
});
