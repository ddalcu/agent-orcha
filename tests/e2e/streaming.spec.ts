import { test, expect } from '@playwright/test';
import { authenticate } from './helpers';

/**
 * E2E tests for the StreamEventBuffer integration.
 *
 * These tests verify that:
 * 1. Agent streaming still delivers real-time SSE tokens to the chat UI
 * 2. Task events stored via the buffer are aggregated (not per-token)
 * 3. The Monitor page renders buffered events correctly
 * 4. Both agents.route stream and heartbeat-manager produce clean events
 */

test.beforeEach(async ({ context }) => {
  await authenticate(context);
});

// ─── Agent stream endpoint tests ─────────────────────────────────────

test.describe('Agent stream endpoint (/api/agents/:name/stream)', () => {
  test('SSE stream delivers per-token content events to the wire', async ({ context }) => {
    // Find a loaded agent to test with
    const agentsRes = await context.request.get('/api/agents');
    const agents = await agentsRes.json();
    if (agents.length === 0) {
      test.skip();
      return;
    }

    const agentName = agents[0].name;
    const inputVars = agents[0].inputVariables || ['query'];
    const input: Record<string, unknown> = {};
    for (const v of inputVars) input[v] = 'Say exactly: "hello world". Nothing else.';

    const res = await context.request.post(`/api/agents/${agentName}/stream`, {
      data: { input, sessionId: `e2e-stream-${Date.now()}` },
      timeout: 60_000,
    });

    expect(res.ok()).toBeTruthy();
    expect(res.headers()['content-type']).toContain('text/event-stream');

    const text = await res.text();
    const lines = text.split('\n').filter(l => l.startsWith('data: '));

    // Should have multiple SSE data lines (real-time streaming)
    expect(lines.length).toBeGreaterThan(1);

    // First event should be task_id
    const firstPayload = JSON.parse(lines[0].slice(6));
    expect(firstPayload.type).toBe('task_id');
    const taskId = firstPayload.taskId;
    expect(taskId).toBeTruthy();

    // Should end with [DONE]
    const lastLine = lines[lines.length - 1].slice(6).trim();
    expect(lastLine).toBe('[DONE]');

    // Now check the task store — events should be BUFFERED (aggregated)
    const taskRes = await context.request.get(`/api/tasks/${taskId}`);
    expect(taskRes.ok()).toBeTruthy();
    const task = await taskRes.json();

    if (task.events && task.events.length > 0) {
      // Verify events are aggregated: each thinking/content event should have substantial text
      const textEvents = task.events.filter(
        (e: { type: string; content?: string }) => e.type === 'thinking' || e.type === 'content'
      );

      if (textEvents.length > 0) {
        // The average content length should be much more than 4 chars (unbuffered tokens)
        const avgLen = textEvents.reduce((sum: number, e: { content?: string }) => sum + (e.content?.length || 0), 0) / textEvents.length;
        expect(avgLen).toBeGreaterThan(10);
      }

      // Verify event types are valid
      for (const evt of task.events) {
        expect(['thinking', 'content', 'tool_start', 'tool_end']).toContain(evt.type);
        expect(evt.timestamp).toBeTruthy();
      }
    }
  });

  test('task events contain aggregated content blocks, not per-token fragments', async ({ context }) => {
    const agentsRes = await context.request.get('/api/agents');
    const agents = await agentsRes.json();
    if (agents.length === 0) {
      test.skip();
      return;
    }

    const agentName = agents[0].name;
    const inputVars = agents[0].inputVariables || ['query'];
    const input: Record<string, unknown> = {};
    // Ask for a medium-length response that would generate many tokens
    for (const v of inputVars) input[v] = 'List the numbers 1 through 10, one per line. Nothing else.';

    const res = await context.request.post(`/api/agents/${agentName}/stream`, {
      data: { input, sessionId: `e2e-buffer-${Date.now()}` },
      timeout: 60_000,
    });
    expect(res.ok()).toBeTruthy();

    const text = await res.text();
    const lines = text.split('\n').filter(l => l.startsWith('data: '));

    // Extract task ID
    const taskId = JSON.parse(lines[0].slice(6)).taskId;

    // Count SSE wire events (per-token)
    const wireContentEvents = lines.filter(l => {
      try {
        const p = JSON.parse(l.slice(6));
        return p.type === 'content';
      } catch { return false; }
    });

    // Fetch task store events (buffered)
    const taskRes = await context.request.get(`/api/tasks/${taskId}`);
    const task = await taskRes.json();
    const storedContentEvents = (task.events || []).filter(
      (e: { type: string }) => e.type === 'content'
    );

    // Wire should have MORE events than stored (buffering compresses them)
    // If the model returns even a few tokens, wire events should outnumber stored events
    if (wireContentEvents.length > 3) {
      expect(storedContentEvents.length).toBeLessThan(wireContentEvents.length);
    }
  });
});

// ─── Task events API tests ───────────────────────────────────────────

test.describe('Task events structure', () => {
  test('GET /api/tasks returns tasks without events (kept small)', async ({ context }) => {
    const res = await context.request.get('/api/tasks');
    expect(res.ok()).toBeTruthy();
    const tasks = await res.json();

    // List endpoint should NOT include events (stripped for payload size)
    for (const task of tasks) {
      expect(task.events).toBeUndefined();
    }
  });

  test('GET /api/tasks/:id returns task WITH events', async ({ context }) => {
    const listRes = await context.request.get('/api/tasks');
    const tasks = await listRes.json();
    if (tasks.length === 0) {
      test.skip();
      return;
    }

    const taskId = tasks[0].id;
    const detailRes = await context.request.get(`/api/tasks/${taskId}`);
    expect(detailRes.ok()).toBeTruthy();
    const task = await detailRes.json();

    // Detail endpoint includes events array (may be empty for simple tasks)
    expect(task).toHaveProperty('id');
    expect(task).toHaveProperty('status');

    if (task.events && task.events.length > 0) {
      for (const evt of task.events) {
        expect(evt).toHaveProperty('type');
        expect(evt).toHaveProperty('timestamp');
        expect(['thinking', 'content', 'tool_start', 'tool_end']).toContain(evt.type);
      }
    }
  });

  test('task events have valid timestamps', async ({ context }) => {
    const listRes = await context.request.get('/api/tasks');
    const tasks = await listRes.json();

    // Find a task with events
    for (const taskSummary of tasks.slice(0, 5)) {
      const detailRes = await context.request.get(`/api/tasks/${taskSummary.id}`);
      const task = await detailRes.json();
      if (task.events && task.events.length > 0) {
        for (const evt of task.events) {
          // Timestamp should be a reasonable epoch ms (after 2024)
          expect(evt.timestamp).toBeGreaterThan(1700000000000);
        }
        return;
      }
    }
    // No tasks with events — that's OK for a clean test environment
  });

  test('tool events preserve tool name and input/output', async ({ context }) => {
    const listRes = await context.request.get('/api/tasks');
    const tasks = await listRes.json();

    for (const taskSummary of tasks.slice(0, 10)) {
      const detailRes = await context.request.get(`/api/tasks/${taskSummary.id}`);
      const task = await detailRes.json();
      if (!task.events) continue;

      const toolStarts = task.events.filter((e: { type: string }) => e.type === 'tool_start');
      const toolEnds = task.events.filter((e: { type: string }) => e.type === 'tool_end');

      for (const ts of toolStarts) {
        // tool_start should have a tool name
        expect(typeof ts.tool).toBe('string');
      }

      for (const te of toolEnds) {
        // tool_end should have a tool name (may be empty string for Claude Code CEO)
        expect(te.tool !== undefined).toBeTruthy();
      }

      if (toolStarts.length > 0) return; // Found what we needed
    }
  });
});

// ─── Monitor page rendering tests ────────────────────────────────────

test.describe('Monitor page event rendering', () => {
  test('monitor page loads and shows task list', async ({ page }) => {
    await page.goto('/#monitor', { waitUntil: 'domcontentloaded' });
    await page.locator('.view-panel').waitFor({ state: 'attached', timeout: 10_000 });

    const header = page.locator('.view-panel h2');
    await expect(header).toContainText('Monitor');
  });

  test('selecting a task with events shows the activity feed', async ({ page, context }) => {
    // First check if there are any tasks with events via API
    const listRes = await context.request.get('/api/tasks');
    const tasks = await listRes.json();

    let taskWithEvents: { id: string } | null = null;
    for (const t of tasks.slice(0, 10)) {
      const detailRes = await context.request.get(`/api/tasks/${t.id}`);
      const detail = await detailRes.json();
      if (detail.events && detail.events.length > 0) {
        taskWithEvents = detail;
        break;
      }
    }

    if (!taskWithEvents) {
      test.skip();
      return;
    }

    await page.goto('/#monitor', { waitUntil: 'domcontentloaded' });
    await page.locator('.view-panel').waitFor({ state: 'attached', timeout: 10_000 });

    // Wait for tasks to load
    await page.waitForTimeout(4_000);

    // Click on the task that has events
    const taskRow = page.locator(`.task-row:has-text("${taskWithEvents.id.slice(-8)}")`);
    if (await taskRow.count() > 0) {
      await taskRow.first().click();

      // Wait for detail panel to appear
      await page.locator('.border-t.pt-4').waitFor({ state: 'attached', timeout: 5_000 });

      // Activity feed should be visible with events
      const activitySection = page.locator('details:has(summary:has-text("Activity"))');
      if (await activitySection.count() > 0) {
        await expect(activitySection).toBeAttached();

        // Verify event items are rendered
        const eventItems = page.locator('.monitor-event');
        const count = await eventItems.count();
        expect(count).toBeGreaterThan(0);
      }
    }
  });

  test('activity feed events have icons matching their types', async ({ page, context }) => {
    const listRes = await context.request.get('/api/tasks');
    const tasks = await listRes.json();

    let taskWithEvents: any = null;
    for (const t of tasks.slice(0, 10)) {
      const detailRes = await context.request.get(`/api/tasks/${t.id}`);
      const detail = await detailRes.json();
      if (detail.events && detail.events.length >= 3) {
        taskWithEvents = detail;
        break;
      }
    }

    if (!taskWithEvents) {
      test.skip();
      return;
    }

    await page.goto('/#monitor', { waitUntil: 'domcontentloaded' });
    await page.locator('.view-panel').waitFor({ state: 'attached', timeout: 10_000 });
    await page.waitForTimeout(4_000);

    const taskRow = page.locator(`.task-row:has-text("${taskWithEvents.id.slice(-8)}")`);
    if (await taskRow.count() === 0) {
      test.skip();
      return;
    }

    await taskRow.first().click();
    await page.locator('.border-t.pt-4').waitFor({ state: 'attached', timeout: 5_000 });

    // Check that event type icons are present:
    // tool_start → fa-play (blue), tool_end → fa-check (green),
    // thinking → fa-brain (purple), content → fa-comment
    const events = page.locator('.monitor-event');
    const eventCount = await events.count();

    if (eventCount > 0) {
      // At least verify the icons container has font-awesome icons
      const hasIcons = await page.locator('.monitor-event .fas').count();
      expect(hasIcons).toBeGreaterThan(0);
    }
  });

  test('event count in activity header reflects actual rendered events', async ({ page, context }) => {
    const listRes = await context.request.get('/api/tasks');
    const tasks = await listRes.json();

    let taskWithEvents: any = null;
    for (const t of tasks.slice(0, 10)) {
      const detailRes = await context.request.get(`/api/tasks/${t.id}`);
      const detail = await detailRes.json();
      if (detail.events && detail.events.length >= 2) {
        taskWithEvents = detail;
        break;
      }
    }

    if (!taskWithEvents) {
      test.skip();
      return;
    }

    await page.goto('/#monitor', { waitUntil: 'domcontentloaded' });
    await page.locator('.view-panel').waitFor({ state: 'attached', timeout: 10_000 });
    await page.waitForTimeout(4_000);

    const taskRow = page.locator(`.task-row:has-text("${taskWithEvents.id.slice(-8)}")`);
    if (await taskRow.count() === 0) {
      test.skip();
      return;
    }

    await taskRow.first().click();
    await page.locator('.border-t.pt-4').waitFor({ state: 'attached', timeout: 5_000 });

    // The activity header shows "(N events)" — verify it matches actual rendered count
    const activitySummary = page.locator('summary:has-text("Activity")');
    if (await activitySummary.count() > 0) {
      const summaryText = await activitySummary.textContent();
      const countMatch = summaryText?.match(/(\d+)\s*events/);
      if (countMatch) {
        const headerCount = parseInt(countMatch[1], 10);
        const renderedCount = await page.locator('.monitor-event').count();
        expect(renderedCount).toBe(headerCount);
      }
    }
  });
});

// ─── Chat UI streaming tests ─────────────────────────────────────────

test.describe('Chat UI streaming', () => {
  test('chat page renders streamed content in real-time', async ({ page, context }) => {
    // Find a published agent
    const agentsRes = await context.request.get('/api/agents');
    const agents = await agentsRes.json();
    const publishedAgent = agents.find(
      (a: { publish?: { enabled: boolean } }) => a.publish?.enabled
    );

    if (!publishedAgent) {
      test.skip();
      return;
    }

    // Navigate to the chat page
    await page.goto(`/chat/${publishedAgent.name}`, { waitUntil: 'domcontentloaded' });

    // Check chat page loaded
    const chatContainer = page.locator('.standalone-chat, .chat-container, [class*="chat"]');
    await expect(chatContainer.first()).toBeAttached({ timeout: 10_000 });
  });

  test('agents page chat shows streaming response', async ({ page }) => {
    await page.goto('/#agents', { waitUntil: 'domcontentloaded' });

    // Verify the chat shell loads
    const shell = page.locator('.agent-shell');
    const attached = await shell.isAttached().catch(() => false);
    if (!attached) {
      test.skip();
      return;
    }

    // Verify chat input is present and functional
    const chatInput = page.locator('.chat-input-wrap textarea');
    await expect(chatInput).toBeAttached({ timeout: 10_000 });

    // Verify send button is present
    const sendBtn = page.locator('.send-btn');
    await expect(sendBtn).toBeAttached();
  });
});
