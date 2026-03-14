import { test, expect } from '@playwright/test';
import { authenticate } from './helpers';

interface Agent {
  name: string;
  publish?: boolean | { enabled: boolean; password?: string };
}

function isPublished(agent: Agent): boolean {
  if (typeof agent.publish === 'boolean') return agent.publish;
  if (typeof agent.publish === 'object' && agent.publish !== null) return agent.publish.enabled;
  return false;
}

test.describe('Published Agent Chat', () => {
  let publishedAgent: Agent | null = null;

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ baseURL: 'http://localhost:3000' });
    await authenticate(context);

    const res = await context.request.get('/api/agents');
    if (res.ok()) {
      const agents: Agent[] = await res.json();
      publishedAgent = agents.find(isPublished) || null;
    }

    await context.close();
  });

  test('GET /api/agents returns an array with publish info', async ({ context }) => {
    await authenticate(context);
    const res = await context.request.get('/api/agents');
    expect(res.ok()).toBeTruthy();

    const agents = await res.json();
    expect(Array.isArray(agents)).toBe(true);
  });

  test('published agent chat page loads', async ({ context, page }) => {
    test.skip(!publishedAgent, 'No published agents found — skipping chat page test');

    // The chat config endpoint should work without global auth
    const configRes = await context.request.get(`/api/chat/${publishedAgent!.name}/config`);
    expect(configRes.ok()).toBeTruthy();

    const config = await configRes.json();
    expect(config).toHaveProperty('name');

    // Navigate to the standalone chat page
    await page.goto(`/chat/${publishedAgent!.name}`, { waitUntil: 'domcontentloaded' });
    const chatComponent = page.locator('.standalone-container, .auth-overlay');
    await expect(chatComponent).toBeAttached({ timeout: 10_000 });
  });

  test('chat page has input area and send button', async ({ context, page }) => {
    test.skip(!publishedAgent, 'No published agents found — skipping chat UI test');

    await page.goto(`/chat/${publishedAgent!.name}`, { waitUntil: 'domcontentloaded' });
    const chatComponent = page.locator('.standalone-container, .auth-overlay');
    await expect(chatComponent).toBeAttached({ timeout: 10_000 });

    // Wait for either the chat UI or the password overlay
    const chatInput = page.locator('.chat-input-wrap textarea');
    const passwordInput = page.locator('.auth-card input[type="password"]');

    const hasChat = await chatInput.isVisible().catch(() => false);
    const hasPassword = await passwordInput.isVisible().catch(() => false);

    // One of these should be present
    expect(hasChat || hasPassword).toBe(true);

    if (hasChat) {
      await expect(chatInput).toBeVisible();

      const sendBtn = page.locator('.send-btn');
      await expect(sendBtn).toBeAttached();

      const chatMessages = page.locator('.standalone-messages');
      await expect(chatMessages).toBeAttached();
    }
  });

  test('chat page has header with agent name', async ({ context, page }) => {
    test.skip(!publishedAgent, 'No published agents found — skipping header test');

    await page.goto(`/chat/${publishedAgent!.name}`, { waitUntil: 'domcontentloaded' });
    const chatComponent = page.locator('.standalone-container, .auth-overlay');
    await expect(chatComponent).toBeAttached({ timeout: 10_000 });

    // If password-protected, the agent name appears in the auth overlay
    // If not, it appears in the standalone header
    const hasName = await page.getByText(publishedAgent!.name).first().isVisible().catch(() => false);
    expect(hasName).toBe(true);
  });

  test('chat page has attach button', async ({ context, page }) => {
    test.skip(!publishedAgent, 'No published agents found — skipping attach button test');

    await page.goto(`/chat/${publishedAgent!.name}`, { waitUntil: 'domcontentloaded' });
    const chatComponent = page.locator('.standalone-container, .auth-overlay');
    await expect(chatComponent).toBeAttached({ timeout: 10_000 });

    // Only check attach button if we got past the password screen
    const chatInput = page.locator('.chat-input-wrap textarea');
    const hasChat = await chatInput.isVisible().catch(() => false);

    if (hasChat) {
      const attachBtn = page.locator('.attach-btn');
      await expect(attachBtn).toBeAttached();

      const fileInput = page.locator('.chat-input-wrap input[type="file"]');
      await expect(fileInput).toBeAttached();
    }
  });

  test('invalid agent name shows error state', async ({ page }) => {
    await page.goto('/chat/nonexistent-agent-xyz-12345', { waitUntil: 'domcontentloaded' });

    // Should show "not found or not published" message
    const errorText = page.getByText(/not found|not published/i);
    await expect(errorText).toBeVisible({ timeout: 15_000 });
  });
});
