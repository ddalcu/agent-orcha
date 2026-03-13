import { z } from 'zod';
import { tool } from '../types/tool-factory.ts';
import { CDPClient } from './cdp-client.ts';
import { PageReadiness } from './page-readiness.ts';
import type { StructuredTool, ContentPart } from '../types/llm-types.ts';
import type { SandboxConfig } from './types.ts';

const DEFAULT_SETTLE_MS = 150;

/** Key name → CDP key descriptor mapping for common keys. */
const KEY_MAP: Record<string, { key: string; code: string; keyCode: number; windowsVirtualKeyCode: number }> = {
  enter:     { key: 'Enter',     code: 'Enter',       keyCode: 13, windowsVirtualKeyCode: 13 },
  tab:       { key: 'Tab',       code: 'Tab',         keyCode: 9,  windowsVirtualKeyCode: 9 },
  escape:    { key: 'Escape',    code: 'Escape',      keyCode: 27, windowsVirtualKeyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace',   keyCode: 8,  windowsVirtualKeyCode: 8 },
  delete:    { key: 'Delete',    code: 'Delete',      keyCode: 46, windowsVirtualKeyCode: 46 },
  arrowup:   { key: 'ArrowUp',   code: 'ArrowUp',     keyCode: 38, windowsVirtualKeyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown',   keyCode: 40, windowsVirtualKeyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft',   keyCode: 37, windowsVirtualKeyCode: 37 },
  arrowright:{ key: 'ArrowRight',code: 'ArrowRight',  keyCode: 39, windowsVirtualKeyCode: 39 },
  space:     { key: ' ',         code: 'Space',        keyCode: 32, windowsVirtualKeyCode: 32 },
  home:      { key: 'Home',      code: 'Home',         keyCode: 36, windowsVirtualKeyCode: 36 },
  end:       { key: 'End',       code: 'End',          keyCode: 35, windowsVirtualKeyCode: 35 },
  pageup:    { key: 'PageUp',    code: 'PageUp',       keyCode: 33, windowsVirtualKeyCode: 33 },
  pagedown:  { key: 'PageDown',  code: 'PageDown',     keyCode: 34, windowsVirtualKeyCode: 34 },
};

export function createVisionBrowserTools(config: SandboxConfig): StructuredTool[] {
  const cdpUrl = config.browserCdpUrl;
  let client: CDPClient | null = null;
  let readiness: PageReadiness | null = null;

  async function getReady(): Promise<{ cdp: CDPClient; ready: PageReadiness }> {
    if (client?.connected && readiness) {
      return { cdp: client, ready: readiness };
    }

    // Clean up old instances before reconnecting
    if (readiness) {
      readiness.detach();
      readiness = null;
    }
    if (client) {
      await client.close();
      client = null;
    }

    client = new CDPClient();
    await client.connect(cdpUrl);
    readiness = new PageReadiness(client);
    await readiness.attach();
    return { cdp: client, ready: readiness };
  }

  async function captureScreenshot(cdp: CDPClient): Promise<ContentPart> {
    const result = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 40 });
    return { type: 'image', data: (result as any).data as string, mediaType: 'image/jpeg' };
  }

  async function settle(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
  }

  function errorResult(error: unknown): string {
    const msg = error instanceof Error ? error.message : String(error);
    return JSON.stringify({ error: msg });
  }

  async function dispatchMouseEvent(
    cdp: CDPClient,
    type: string,
    x: number,
    y: number,
    button?: 'left' | 'right' | 'middle',
  ): Promise<void> {
    await cdp.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: button ?? 'left',
      clickCount: type === 'mousePressed' || type === 'mouseReleased' ? 1 : 0,
      buttons: type === 'mousePressed' ? 1 : 0,
    });
  }

  async function dispatchKey(cdp: CDPClient, keyName: string): Promise<void> {
    const mapped = KEY_MAP[keyName.toLowerCase()];
    if (mapped) {
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: mapped.key,
        code: mapped.code,
        windowsVirtualKeyCode: mapped.windowsVirtualKeyCode,
        nativeVirtualKeyCode: mapped.windowsVirtualKeyCode,
      });
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: mapped.key,
        code: mapped.code,
        windowsVirtualKeyCode: mapped.windowsVirtualKeyCode,
        nativeVirtualKeyCode: mapped.windowsVirtualKeyCode,
      });
    } else if (keyName.length === 1) {
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: keyName,
        text: keyName,
      });
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: keyName,
      });
    } else {
      throw new Error(`Unknown key: ${keyName}`);
    }
  }

  // -- vision_screenshot --

  const visionScreenshot = tool(
    async (): Promise<string | ContentPart[]> => {
      try {
        const { cdp } = await getReady();
        const img = await captureScreenshot(cdp);
        return [img, { type: 'text', text: 'Screenshot captured.' }];
      } catch (e) {
        return errorResult(e);
      }
    },
    {
      name: 'sandbox_vision_screenshot',
      description: 'Take a screenshot of the current page. Use for initial observation only — action tools return screenshots automatically.',
      schema: z.object({}),
    },
  );

  // -- vision_navigate --

  const visionNavigate = tool(
    async ({ url }): Promise<string | ContentPart[]> => {
      try {
        const { cdp, ready } = await getReady();
        ready.resetForNavigation();
        await cdp.send('Page.navigate', { url });
        await ready.waitForReady(config.commandTimeout);
        const img = await captureScreenshot(cdp);
        return [img, { type: 'text', text: `Navigated to ${url}` }];
      } catch (e) {
        return errorResult(e);
      }
    },
    {
      name: 'sandbox_vision_navigate',
      description: 'Navigate to URL. Waits for load, returns screenshot.',
      schema: z.object({
        url: z.string().describe('The URL to navigate to'),
      }),
    },
  );

  // -- vision_click --

  const visionClick = tool(
    async ({ x, y, button, waitMs }): Promise<string | ContentPart[]> => {
      try {
        const { cdp } = await getReady();
        await dispatchMouseEvent(cdp, 'mouseMoved', x, y);
        await dispatchMouseEvent(cdp, 'mousePressed', x, y, button);
        await dispatchMouseEvent(cdp, 'mouseReleased', x, y, button);
        await settle(waitMs ?? DEFAULT_SETTLE_MS);
        const img = await captureScreenshot(cdp);
        return [img, { type: 'text', text: `Clicked (${x}, ${y})` }];
      } catch (e) {
        return errorResult(e);
      }
    },
    {
      name: 'sandbox_vision_click',
      description: 'Click at pixel coordinates (x, y). Returns screenshot after action.',
      schema: z.object({
        x: z.coerce.number().describe('X pixel coordinate'),
        y: z.coerce.number().describe('Y pixel coordinate'),
        button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button (default: left)'),
        waitMs: z.coerce.number().optional().describe('Settle wait in ms (default: 150)'),
      }),
    },
  );

  // -- vision_type --

  const visionType = tool(
    async ({ x, y, text, pressEnter, waitMs }): Promise<string | ContentPart[]> => {
      try {
        const { cdp } = await getReady();
        // Click to focus
        await dispatchMouseEvent(cdp, 'mouseMoved', x, y);
        await dispatchMouseEvent(cdp, 'mousePressed', x, y);
        await dispatchMouseEvent(cdp, 'mouseReleased', x, y);
        await settle(50);
        // Select all existing text
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'a',
          code: 'KeyA',
          modifiers: 2, // Ctrl
          windowsVirtualKeyCode: 65,
        });
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'a',
          code: 'KeyA',
          modifiers: 2,
          windowsVirtualKeyCode: 65,
        });
        // Insert text (fast — single CDP call, no per-char events)
        await cdp.send('Input.insertText', { text });
        if (pressEnter) {
          await dispatchKey(cdp, 'enter');
        }
        await settle(waitMs ?? DEFAULT_SETTLE_MS);
        const img = await captureScreenshot(cdp);
        return [img, { type: 'text', text: `Typed "${text}" at (${x}, ${y})${pressEnter ? ' + Enter' : ''}` }];
      } catch (e) {
        return errorResult(e);
      }
    },
    {
      name: 'sandbox_vision_type',
      description: 'Click at (x, y) to focus, select all, type text. Returns screenshot.',
      schema: z.object({
        x: z.coerce.number().describe('X pixel coordinate of the input field'),
        y: z.coerce.number().describe('Y pixel coordinate of the input field'),
        text: z.string().describe('Text to type'),
        pressEnter: z.boolean().optional().describe('Press Enter after typing (default: false)'),
        waitMs: z.coerce.number().optional().describe('Settle wait in ms (default: 150)'),
      }),
    },
  );

  // -- vision_scroll --

  const visionScroll = tool(
    async ({ x, y, direction, amount, waitMs }): Promise<string | ContentPart[]> => {
      try {
        const { cdp } = await getReady();
        const ticks = amount ?? 3;
        const dir = direction ?? 'down';
        const deltaX = dir === 'left' ? -120 * ticks : dir === 'right' ? 120 * ticks : 0;
        const deltaY = dir === 'up' ? -120 * ticks : dir === 'down' ? 120 * ticks : 0;
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x,
          y,
          deltaX,
          deltaY,
        });
        await settle(waitMs ?? DEFAULT_SETTLE_MS);
        const img = await captureScreenshot(cdp);
        return [img, { type: 'text', text: `Scrolled ${dir} ${ticks} ticks at (${x}, ${y})` }];
      } catch (e) {
        return errorResult(e);
      }
    },
    {
      name: 'sandbox_vision_scroll',
      description: 'Scroll at pixel coordinates. Returns screenshot.',
      schema: z.object({
        x: z.coerce.number().describe('X pixel coordinate'),
        y: z.coerce.number().describe('Y pixel coordinate'),
        direction: z.enum(['up', 'down', 'left', 'right']).optional().describe('Scroll direction (default: down)'),
        amount: z.coerce.number().optional().describe('Number of scroll ticks (default: 3)'),
        waitMs: z.coerce.number().optional().describe('Settle wait in ms (default: 150)'),
      }),
    },
  );

  // -- vision_key --

  const visionKey = tool(
    async ({ key, waitMs }): Promise<string | ContentPart[]> => {
      try {
        const { cdp } = await getReady();
        await dispatchKey(cdp, key);
        await settle(waitMs ?? DEFAULT_SETTLE_MS);
        const img = await captureScreenshot(cdp);
        return [img, { type: 'text', text: `Pressed key: ${key}` }];
      } catch (e) {
        return errorResult(e);
      }
    },
    {
      name: 'sandbox_vision_key',
      description: 'Press a keyboard key. Supports: Enter, Tab, Escape, Backspace, Delete, arrows, Space, Home, End, PageUp, PageDown, or single characters. Returns screenshot.',
      schema: z.object({
        key: z.string().describe('Key name (e.g. "Enter", "Tab", "Escape", "ArrowDown") or single character'),
        waitMs: z.coerce.number().optional().describe('Settle wait in ms (default: 150)'),
      }),
    },
  );

  // -- vision_drag --

  const visionDrag = tool(
    async ({ fromX, fromY, toX, toY, waitMs }): Promise<string | ContentPart[]> => {
      try {
        const { cdp } = await getReady();
        await dispatchMouseEvent(cdp, 'mouseMoved', fromX, fromY);
        await dispatchMouseEvent(cdp, 'mousePressed', fromX, fromY);
        // Move in steps for smoother drag
        const steps = 5;
        for (let i = 1; i <= steps; i++) {
          const ix = fromX + (toX - fromX) * (i / steps);
          const iy = fromY + (toY - fromY) * (i / steps);
          await cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: Math.round(ix),
            y: Math.round(iy),
            buttons: 1,
          });
        }
        await dispatchMouseEvent(cdp, 'mouseReleased', toX, toY);
        await settle(waitMs ?? DEFAULT_SETTLE_MS);
        const img = await captureScreenshot(cdp);
        return [img, { type: 'text', text: `Dragged from (${fromX}, ${fromY}) to (${toX}, ${toY})` }];
      } catch (e) {
        return errorResult(e);
      }
    },
    {
      name: 'sandbox_vision_drag',
      description: 'Drag from one point to another. Returns screenshot.',
      schema: z.object({
        fromX: z.coerce.number().describe('Start X coordinate'),
        fromY: z.coerce.number().describe('Start Y coordinate'),
        toX: z.coerce.number().describe('End X coordinate'),
        toY: z.coerce.number().describe('End Y coordinate'),
        waitMs: z.coerce.number().optional().describe('Settle wait in ms (default: 150)'),
      }),
    },
  );

  return [visionScreenshot, visionNavigate, visionClick, visionType, visionScroll, visionKey, visionDrag];
}
