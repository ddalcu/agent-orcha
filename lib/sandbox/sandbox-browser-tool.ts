import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { StructuredTool } from '@langchain/core/tools';
import type { DockerManager } from './docker-manager.js';
import type { SandboxConfig } from './types.js';

/**
 * Persistent Node.js HTTP server that runs inside the container.
 * Launches Chromium once on startup and keeps it alive across requests.
 * Accepts batched actions via POST /actions.
 * Auto-exits after 5 minutes of inactivity.
 */
const BROWSER_SERVER_SCRIPT = `
const http = require('http');
const { chromium } = require('playwright');
const fs = require('fs');

const PORT = 9222;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

let browser = null;
let page = null;
let idleTimer = null;

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    try { if (browser) await browser.close(); } catch (_) {}
    process.exit(0);
  }, IDLE_TIMEOUT_MS);
}

async function ensurePage() {
  if (!page || page.isClosed()) {
    page = await browser.newPage();
  }
  return page;
}

// DOM-to-markdown converter for use inside p.evaluate()
const domToMarkdown = function() {
  const SKIP = new Set(['SCRIPT','STYLE','NAV','FOOTER','HEADER','ASIDE','NOSCRIPT','SVG','IFRAME']);
  const BT = String.fromCharCode(96);
  const BT3 = BT.repeat(3);
  function walk(node) {
    if (node.nodeType === 3) return node.textContent || '';
    if (node.nodeType !== 1) return '';
    if (SKIP.has(node.tagName)) return '';
    const kids = Array.from(node.childNodes).map(walk).join('');
    const t = kids.trim();
    switch (node.tagName) {
      case 'H1': return '\\n# ' + t + '\\n';
      case 'H2': return '\\n## ' + t + '\\n';
      case 'H3': return '\\n### ' + t + '\\n';
      case 'H4': return '\\n#### ' + t + '\\n';
      case 'H5': return '\\n##### ' + t + '\\n';
      case 'H6': return '\\n###### ' + t + '\\n';
      case 'P': case 'DIV': case 'SECTION': case 'ARTICLE': case 'MAIN':
        return t ? '\\n\\n' + t + '\\n' : '';
      case 'BR': return '\\n';
      case 'STRONG': case 'B': return '**' + kids + '**';
      case 'EM': case 'I': return '*' + kids + '*';
      case 'A': {
        const href = node.getAttribute('href');
        return href && t ? '[' + t + '](' + href + ')' : t;
      }
      case 'UL': case 'OL': return '\\n' + kids + '\\n';
      case 'LI': return '\\n- ' + t;
      case 'PRE': return '\\n' + BT3 + '\\n' + kids + '\\n' + BT3 + '\\n';
      case 'CODE': {
        if (node.parentNode && node.parentNode.tagName === 'PRE') return kids;
        return BT + kids + BT;
      }
      case 'BLOCKQUOTE': return '\\n> ' + t.replace(/\\n/g, '\\n> ') + '\\n';
      case 'HR': return '\\n---\\n';
      case 'IMG': {
        const alt = node.getAttribute('alt') || '';
        const src = node.getAttribute('src') || '';
        return src ? '![' + alt + '](' + src + ')' : '';
      }
      default: return kids;
    }
  }
  let r = walk(document.body);
  return r.replace(/\\n{3,}/g, '\\n\\n').trim();
};

async function executeAction(action) {
  const p = await ensurePage();

  switch (action.action) {
    case 'navigate': {
      await p.goto(action.url, { waitUntil: 'domcontentloaded', timeout: action.timeout || 15000 });
      return { title: await p.title(), url: p.url() };
    }
    case 'screenshot': {
      const dest = action.path || '/workspace/screenshot.png';
      await p.screenshot({ path: dest, fullPage: action.fullPage || false });
      const b64 = fs.readFileSync(dest).toString('base64');
      return { path: dest, base64Length: b64.length, base64: b64.substring(0, 200) + '...' };
    }
    case 'click': {
      await p.click(action.selector, { timeout: action.timeout || 5000 });
      return { clicked: action.selector, title: await p.title(), url: p.url() };
    }
    case 'type': {
      await p.type(action.selector, action.text, { delay: action.delay || 50 });
      return { typed: action.text, into: action.selector };
    }
    case 'fill': {
      await p.fill(action.selector, action.value);
      return { filled: action.selector, value: action.value };
    }
    case 'content': {
      const md = await p.evaluate(domToMarkdown);
      return { title: await p.title(), url: p.url(), content: md.substring(0, 50000), truncated: md.length > 50000 };
    }
    case 'snapshot': {
      const title = await p.title();
      const url = p.url();
      const md = await p.evaluate(domToMarkdown);
      return { title, url, content: md.substring(0, 30000), truncated: md.length > 30000 };
    }
    case 'evaluate': {
      const evalResult = await p.evaluate(action.script);
      return { result: JSON.stringify(evalResult) };
    }
    case 'wait': {
      const ms = action.timeout || 1000;
      await new Promise(r => setTimeout(r, ms));
      return { waited: ms };
    }
    case 'new_page': {
      if (page && !page.isClosed()) await page.close();
      page = await browser.newPage();
      return { newPage: true };
    }
    default:
      return { error: 'Unknown action: ' + action.action };
  }
}

async function handleActions(actions) {
  const results = [];
  for (const action of actions) {
    try {
      const result = await executeAction(action);
      results.push({ success: true, action: action.action, ...result });
      if (result.error && action.stopOnError !== false) break;
    } catch (err) {
      results.push({ success: false, action: action.action, error: err.message });
      if (action.stopOnError !== false) break;
    }
  }
  return results;
}

(async () => {
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  page = await browser.newPage();

  const server = http.createServer(async (req, res) => {
    resetIdleTimer();

    if (req.method === 'GET' && req.url === '/health') {
      const currentUrl = (page && !page.isClosed()) ? page.url() : null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), url: currentUrl }));
      return;
    }

    if (req.method === 'POST' && req.url === '/actions') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const { actions } = JSON.parse(body);
        if (!Array.isArray(actions) || actions.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'actions must be a non-empty array' }));
          return;
        }
        const results = await handleActions(actions);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/reset') {
      try {
        if (page && !page.isClosed()) await page.close();
        page = await browser.newPage();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'reset' }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(PORT, '127.0.0.1', () => {
    resetIdleTimer();
    console.log('BROWSER_SERVER_READY on port ' + PORT);
  });
})().catch(err => {
  console.error('Server startup failed:', err.message);
  process.exit(1);
});
`.trim();

const BrowserActionSchema = z.object({
  action: z.enum([
    'navigate', 'screenshot', 'click', 'type', 'fill',
    'content', 'snapshot', 'evaluate', 'wait', 'new_page',
  ]).describe('The browser action to perform'),
  url: z.string().optional().describe('URL to navigate to (required for "navigate")'),
  selector: z.string().optional().describe('CSS selector for click/type/fill actions'),
  text: z.string().optional().describe('Text to type (for "type" action)'),
  value: z.string().optional().describe('Value to fill (for "fill" action)'),
  script: z.string().optional().describe('JavaScript to evaluate (for "evaluate" action)'),
  path: z.string().optional().describe('File path for screenshot (defaults to /workspace/screenshot.png)'),
  fullPage: z.boolean().optional().describe('Take full-page screenshot (for "screenshot" action)'),
  timeout: z.number().optional().describe('Timeout in ms for the action or wait duration'),
  delay: z.number().optional().describe('Typing delay in ms (for "type" action)'),
  stopOnError: z.boolean().optional().describe('Stop batch on this action\'s error (default: true)'),
});

/**
 * Creates a tool for browser automation inside the Docker sandbox container.
 * Uses a persistent Chromium instance via an in-container HTTP server.
 * Supports batching multiple actions per call for efficiency.
 */
export function createSandboxBrowserTool(
  dockerManager: DockerManager,
  config: SandboxConfig,
): StructuredTool {
  let containerName: string | null = null;
  let serverScriptWritten = false;
  let serverRunning = false;

  async function ensureServer(): Promise<void> {
    if (!containerName) {
      await dockerManager.ensureImage(config.image);
      containerName = await dockerManager.getOrCreateContainer('default');
    }

    // Write server script once per session
    if (!serverScriptWritten) {
      const b64 = Buffer.from(BROWSER_SERVER_SCRIPT, 'utf-8').toString('base64');
      await dockerManager.execInContainer(
        containerName,
        `echo '${b64}' | base64 -d > /workspace/.browser-server.js`,
      );
      serverScriptWritten = true;
    }

    // Check if server is already responding
    if (serverRunning) {
      const health = await dockerManager.execInContainer(
        containerName,
        `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9222/health`,
        undefined,
        5_000,
      );
      if (health.exitCode === 0 && health.stdout.trim() === '200') {
        return;
      }
      serverRunning = false;
    }

    // Start the server in the background
    await dockerManager.execInContainer(
      containerName,
      `nohup node /workspace/.browser-server.js > /workspace/.browser-server.log 2>&1 &`,
      undefined,
      5_000,
    );

    // Poll until the server is ready (up to 15 attempts, 500ms apart)
    for (let i = 0; i < 15; i++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const health = await dockerManager.execInContainer(
        containerName,
        `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9222/health`,
        undefined,
        5_000,
      );
      if (health.exitCode === 0 && health.stdout.trim() === '200') {
        serverRunning = true;
        return;
      }
    }

    throw new Error('Browser server failed to start within timeout');
  }

  async function sendActions(actions: unknown[]): Promise<string> {
    const payload = JSON.stringify({ actions });
    const b64 = Buffer.from(payload, 'utf-8').toString('base64');
    const command = `echo '${b64}' | base64 -d | curl -s -X POST -H 'Content-Type: application/json' -d @- http://127.0.0.1:9222/actions`;

    const result = await dockerManager.execInContainer(
      containerName!,
      command,
      undefined,
      60_000,
    );

    if (result.exitCode !== 0) {
      serverRunning = false;
      throw new Error(result.stderr || `Browser action failed (exit code ${result.exitCode})`);
    }

    return result.stdout.trim();
  }

  return tool(
    async ({ actions }) => {
      try {
        await ensureServer();
        const raw = await sendActions(actions);

        // Parse to validate, then return
        try {
          const parsed = JSON.parse(raw);
          return JSON.stringify(parsed, null, 2);
        } catch {
          return raw;
        }
      } catch (err: unknown) {
        serverRunning = false;
        const message = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: message });
      }
    },
    {
      name: 'sandbox_browser',
      description:
        'Control a persistent headless Chromium browser inside the Docker sandbox. ' +
        'The browser stays alive between calls — state, cookies, and the current URL carry over. ' +
        'Send one or more actions per call (batching is more efficient). ' +
        'Actions: navigate, screenshot, click, type, fill, content, snapshot, evaluate, wait, new_page. ' +
        'Use "new_page" to reset browser state when you need a fresh page.',
      schema: z.object({
        actions: z.array(BrowserActionSchema).min(1).max(10)
          .describe('Array of browser actions to execute sequentially'),
      }),
    },
  );
}
