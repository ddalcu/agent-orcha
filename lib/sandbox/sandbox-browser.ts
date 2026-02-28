import { z } from 'zod';
import { tool } from '../types/tool-factory.ts';
import { htmlToMarkdown } from './html-to-markdown.ts';
import { CDPClient } from './cdp-client.ts';
import { PageReadiness } from './page-readiness.ts';
import type { StructuredTool, ContentPart } from '../types/llm-types.ts';
import type { SandboxConfig } from './types.ts';

export function createBrowserTools(config: SandboxConfig): StructuredTool[] {
  const cdpUrl = config.browserCdpUrl;
  let client: CDPClient | null = null;
  let readiness: PageReadiness | null = null;

  async function getReady(): Promise<{ cdp: CDPClient; ready: PageReadiness }> {
    if (client?.connected && readiness) {
      return { cdp: client, ready: readiness };
    }
    client = new CDPClient();
    await client.connect(cdpUrl);
    readiness = new PageReadiness(client);
    await readiness.attach();
    return { cdp: client, ready: readiness };
  }

  function errorResult(error: unknown): string {
    const msg = error instanceof Error ? error.message : String(error);
    return JSON.stringify({ error: msg });
  }

  // -- observe: cheap text snapshot of the page (primary verification tool) --

  const observe = tool(
    async () => {
      try {
        const { ready } = await getReady();
        const snapshot = await ready.observe();
        return JSON.stringify(snapshot);
      } catch (e) {
        return errorResult(e);
      }
    },
    {
      name: 'sandbox_browser_observe',
      description:
        'Text snapshot of current page: URL, title, headings, interactive elements with refs. Use before/after actions.',
      schema: z.object({}),
    },
  );

  // -- navigate: go to URL, wait for readiness, return observe snapshot --

  const navigate = tool(
    async ({ url }) => {
      try {
        const { cdp, ready } = await getReady();
        ready.resetForNavigation();
        await cdp.send('Page.navigate', { url });
        await ready.waitForReady(config.commandTimeout);
        const snapshot = await ready.observe();
        return JSON.stringify(snapshot);
      } catch (e) {
        return errorResult(e);
      }
    },
    {
      name: 'sandbox_browser_navigate',
      description:
        'Navigate to URL. Waits for load+idle. Returns text snapshot with interactive elements.',
      schema: z.object({
        url: z.string().describe('The URL to navigate to'),
      }),
    },
  );

  // -- screenshot: expensive visual capture, use only when text observation is insufficient --

  const screenshot = tool(
    async (): Promise<string | ContentPart[]> => {
      try {
        const { cdp } = await getReady();
        const result = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 75 });
        const data = (result as any).data as string;
        return [
          { type: 'image', data, mediaType: 'image/jpeg' },
          { type: 'text', text: 'Screenshot captured.' },
        ];
      } catch (e) {
        return errorResult(e);
      }
    },
    {
      name: 'sandbox_browser_screenshot',
      description:
        'JPEG screenshot. Expensive — only when observe/content insufficient (CAPTCHAs, charts).',
      schema: z.object({}),
    },
  );

  // -- content: full page or element as markdown --

  const content = tool(
    async ({ selector }) => {
      try {
        const { cdp } = await getReady();
        const expression = selector
          ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.outerHTML : null; })()`
          : 'document.documentElement.outerHTML';
        const result = await cdp.send('Runtime.evaluate', { expression });
        const html = (result as any).result?.value;
        if (!html) {
          return JSON.stringify({ error: selector ? `Element not found: ${selector}` : 'No content' });
        }
        const markdown = htmlToMarkdown(html, { includeNavigation: !!selector });
        let output = JSON.stringify({ content: markdown, selector: selector ?? null });
        if (output.length > config.maxOutputChars) {
          const truncated = markdown.substring(0, config.maxOutputChars);
          output = JSON.stringify({ content: truncated, truncated: true, selector: selector ?? null });
        }
        return output;
      } catch (e) {
        return errorResult(e);
      }
    },
    {
      name: 'sandbox_browser_content',
      description:
        'Page content as markdown. Use selector to target a specific element.',
      schema: z.object({
        selector: z
          .string()
          .optional()
          .describe('CSS selector to extract a specific element (optional, defaults to full page)'),
      }),
    },
  );

  // -- evaluate: run arbitrary JS, report side effects --

  const evaluate = tool(
    async ({ expression }) => {
      try {
        const { cdp, ready } = await getReady();

        const preUrl = await cdp.send('Runtime.evaluate', {
          expression: 'location.href',
          returnByValue: true,
        });
        const preUrlValue = (preUrl as any).result?.value;

        ready.resetNetworkFlag();

        const result = await cdp.send('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: true,
        });

        const val = (result as any).result;
        if (val?.subtype === 'error' || (result as any).exceptionDetails) {
          const errMsg =
            (result as any).exceptionDetails?.exception?.description ??
            val?.description ??
            'Evaluation error';
          return JSON.stringify({ error: errMsg });
        }

        await ready.waitForSettle(300);

        const postUrl = await cdp.send('Runtime.evaluate', {
          expression: 'location.href',
          returnByValue: true,
        });
        const postUrlValue = (postUrl as any).result?.value;

        const sideEffects: Record<string, unknown> = {};
        if (preUrlValue !== postUrlValue) {
          sideEffects.urlChanged = { from: preUrlValue, to: postUrlValue };
        }
        if (ready.hadNetworkActivity()) {
          sideEffects.networkTriggered = true;
        }

        return JSON.stringify({
          result: val?.value ?? null,
          type: val?.type ?? 'undefined',
          ...(Object.keys(sideEffects).length > 0 ? { sideEffects } : {}),
        });
      } catch (e) {
        return errorResult(e);
      }
    },
    {
      name: 'sandbox_browser_evaluate',
      description:
        'Run JavaScript in browser. Returns result + side effects. Prefer click/type for interactions.',
      schema: z.object({
        expression: z.string().describe('JavaScript expression to evaluate in the page'),
      }),
    },
  );

  // -- click: find element, scroll, click, return lightweight result --

  const click = tool(
    async ({ ref, text }) => {
      try {
        const { cdp, ready } = await getReady();

        // Resolve ref (e.g. "e3") to CSS selector
        const selector = ref ? ready.resolveRef(ref) : undefined;

        const findExpr = selector
          ? `(() => {
              const el = document.querySelector(${JSON.stringify(selector)});
              if (!el) return { error: 'Element not found: ' + ${JSON.stringify(ref)} };
              return { found: true, tag: el.tagName.toLowerCase(), text: (el.textContent||'').trim().substring(0,40) };
            })()`
          : `(() => {
              const searchText = ${JSON.stringify(text ?? '')};
              const clickable = document.querySelectorAll('a, button, [role="button"], input[type="submit"], input[type="button"], [onclick], [tabindex]');
              for (const el of clickable) {
                if (el.offsetParent === null) continue;
                if (el.textContent && el.textContent.trim().toLowerCase().includes(searchText.toLowerCase())) {
                  return { found: true, tag: el.tagName.toLowerCase(), text: (el.textContent||'').trim().substring(0,40) };
                }
              }
              return { error: 'No clickable element found containing text: ' + searchText };
            })()`;

        const findResult = await cdp.send('Runtime.evaluate', {
          expression: findExpr,
          returnByValue: true,
        });
        const found = (findResult as any).result?.value;
        if (found?.error) return JSON.stringify(found);

        const preUrl = await cdp.send('Runtime.evaluate', {
          expression: 'location.href',
          returnByValue: true,
        });

        const clickExpr = selector
          ? `(() => {
              const el = document.querySelector(${JSON.stringify(selector)});
              el.scrollIntoView({ block: 'center', behavior: 'instant' });
              el.click();
              return true;
            })()`
          : `(() => {
              const searchText = ${JSON.stringify(text ?? '')};
              const clickable = document.querySelectorAll('a, button, [role="button"], input[type="submit"], input[type="button"], [onclick], [tabindex]');
              for (const el of clickable) {
                if (el.offsetParent === null) continue;
                if (el.textContent && el.textContent.trim().toLowerCase().includes(searchText.toLowerCase())) {
                  el.scrollIntoView({ block: 'center', behavior: 'instant' });
                  el.click();
                  return true;
                }
              }
              return false;
            })()`;

        ready.resetNetworkFlag();

        await cdp.send('Runtime.evaluate', {
          expression: clickExpr,
          returnByValue: true,
          awaitPromise: true,
        });

        await ready.waitForSettle(500);

        const postUrl = await cdp.send('Runtime.evaluate', {
          expression: 'location.href',
          returnByValue: true,
        });

        const preUrlVal = (preUrl as any).result?.value;
        const postUrlVal = (postUrl as any).result?.value;
        const navigated = preUrlVal !== postUrlVal;

        if (navigated) {
          ready.resetForNavigation();
          await ready.waitForReady(config.commandTimeout);
        }

        const titleResult = await cdp.send('Runtime.evaluate', {
          expression: 'document.title',
          returnByValue: true,
        });

        return JSON.stringify({
          clicked: found,
          navigated,
          url: postUrlVal,
          title: (titleResult as any).result?.value ?? '',
        });
      } catch (e) {
        return errorResult(e);
      }
    },
    {
      name: 'sandbox_browser_click',
      description:
        'Click an element by ref from observe output (e.g. "e3") or visible text. Scrolls into view, clicks, waits for effects.',
      schema: z.object({
        ref: z.string().optional().describe('Element ref from observe output (e.g. "e3")'),
        text: z.string().optional().describe('Visible text to find and click'),
      }),
    },
  );

  // -- type: fill an input field --

  const type_ = tool(
    async ({ ref, text, clear }) => {
      try {
        const { cdp, ready } = await getReady();
        const selector = ready.resolveRef(ref);

        const expr = `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { error: 'Element not found: ' + ${JSON.stringify(ref)} };
          if (!('value' in el)) return { error: 'Element is not an input: ' + el.tagName };

          el.scrollIntoView({ block: 'center', behavior: 'instant' });
          el.focus();
          ${clear !== false ? "el.value = '';" : ''}
          el.value = ${JSON.stringify(text)};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));

          return { typed: true, value: el.value };
        })()`;

        const result = await cdp.send('Runtime.evaluate', {
          expression: expr,
          returnByValue: true,
          awaitPromise: true,
        });

        const val = (result as any).result?.value;
        if (val?.error) return JSON.stringify(val);

        await ready.waitForSettle(300);

        return JSON.stringify(val);
      } catch (e) {
        return errorResult(e);
      }
    },
    {
      name: 'sandbox_browser_type',
      description:
        'Type text into an input/textarea by ref from observe output (e.g. "e5"). Handles focus and input/change events.',
      schema: z.object({
        ref: z.string().describe('Element ref from observe output (e.g. "e5")'),
        text: z.string().describe('Text to type'),
        clear: z.boolean().optional().describe('Clear first (default: true)'),
      }),
    },
  );

  return [observe, navigate, screenshot, content, evaluate, click, type_];
}
