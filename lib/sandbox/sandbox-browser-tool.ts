import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { StructuredTool } from '@langchain/core/tools';
import type { DockerManager } from './docker-manager.js';
import type { SandboxConfig } from './types.js';

/**
 * Stateless Playwright helper script that runs inside the container.
 * Each invocation launches a fresh browser, navigates to the given URL,
 * performs the action, and exits. No state persists between calls.
 *
 * Usage: echo '{"action":"snapshot","url":"https://..."}' | node /workspace/.browser-helper.js
 */
const BROWSER_HELPER_SCRIPT = `
const { chromium } = require('playwright');
const fs = require('fs');

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  const cmd = JSON.parse(input.trim());

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const page = await browser.newPage();
  let result = {};

  try {
    if (cmd.url) {
      await page.goto(cmd.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    }

    switch (cmd.action) {
      case 'navigate': {
        result = { title: await page.title(), url: page.url() };
        break;
      }
      case 'screenshot': {
        const p = cmd.path || '/workspace/screenshot.png';
        await page.screenshot({ path: p, fullPage: cmd.fullPage || false });
        const b64 = fs.readFileSync(p).toString('base64');
        result = { path: p, base64Length: b64.length, base64: b64.substring(0, 200) + '...' };
        break;
      }
      case 'click':
        await page.click(cmd.selector, { timeout: 5000 });
        result = { clicked: cmd.selector, title: await page.title(), url: page.url() };
        break;
      case 'type':
        await page.type(cmd.selector, cmd.text, { delay: cmd.delay || 50 });
        result = { typed: cmd.text, into: cmd.selector };
        break;
      case 'fill':
        await page.fill(cmd.selector, cmd.value);
        result = { filled: cmd.selector, value: cmd.value };
        break;
      case 'content': {
        const text = await page.evaluate(() => document.body.innerText);
        result = { title: await page.title(), url: page.url(), content: text.substring(0, 50000), truncated: text.length > 50000 };
        break;
      }
      case 'snapshot': {
        const title = await page.title();
        const url = page.url();
        const text = await page.evaluate(() => document.body.innerText);
        result = { title, url, content: text.substring(0, 30000), truncated: text.length > 30000 };
        break;
      }
      case 'evaluate': {
        const evalResult = await page.evaluate(cmd.script);
        result = { result: JSON.stringify(evalResult) };
        break;
      }
      default:
        result = { error: 'Unknown action: ' + cmd.action };
    }
  } finally {
    await browser.close();
  }

  console.log(JSON.stringify(result));
}

main().catch(err => {
  console.log(JSON.stringify({ error: err.message }));
  process.exit(1);
});
`.trim();

/**
 * Creates a tool for browser automation inside the Docker sandbox container.
 * Uses Playwright + Chromium installed in the container via initCommands.
 * Each call is stateless: launches a browser, navigates, performs action, exits.
 */
export function createSandboxBrowserTool(
  dockerManager: DockerManager,
  config: SandboxConfig,
): StructuredTool {
  let containerName: string | null = null;
  let helperWritten = false;

  return tool(
    async ({ action, url, selector, text, value, script, path, fullPage }) => {
      if (!containerName) {
        await dockerManager.ensureImage(config.image);
        containerName = await dockerManager.getOrCreateContainer('default');
      }

      // Write the helper script once per session
      if (!helperWritten) {
        const b64 = Buffer.from(BROWSER_HELPER_SCRIPT, 'utf-8').toString('base64');
        await dockerManager.execInContainer(
          containerName,
          `echo '${b64}' | base64 -d > /workspace/.browser-helper.js`,
        );
        helperWritten = true;
      }

      const cmd: Record<string, unknown> = { action };
      if (url) cmd.url = url;
      if (selector) cmd.selector = selector;
      if (text) cmd.text = text;
      if (value) cmd.value = value;
      if (script) cmd.script = script;
      if (path) cmd.path = path;
      if (fullPage !== undefined) cmd.fullPage = fullPage;

      const cmdJson = JSON.stringify(cmd);
      const escapedCmd = cmdJson.replace(/'/g, "'\\''");

      const result = await dockerManager.execInContainer(
        containerName,
        `echo '${escapedCmd}' | node /workspace/.browser-helper.js`,
        undefined,
        30_000,
      );

      if (result.exitCode !== 0) {
        return JSON.stringify({
          error: result.stderr || `Browser action failed (exit code ${result.exitCode})`,
          stdout: result.stdout,
        });
      }

      return result.stdout.trim();
    },
    {
      name: 'sandbox_browser',
      description:
        'Control a headless Chromium browser inside the Docker sandbox container using Playwright. ' +
        'Each call is stateless — provide a url with every action to navigate first. ' +
        'Actions: navigate, screenshot, click, type, fill, content, snapshot, evaluate.',
      schema: z.object({
        action: z.enum([
          'navigate', 'screenshot', 'click', 'type', 'fill',
          'content', 'snapshot', 'evaluate',
        ]).describe('The browser action to perform'),
        url: z.string().optional().describe('URL to navigate to before performing the action (required for most actions)'),
        selector: z.string().optional().describe('CSS selector for click/type/fill actions'),
        text: z.string().optional().describe('Text to type (for "type" action)'),
        value: z.string().optional().describe('Value to fill (for "fill" action)'),
        script: z.string().optional().describe('JavaScript to evaluate (for "evaluate" action)'),
        path: z.string().optional().describe('File path for screenshot (defaults to /workspace/screenshot.png)'),
        fullPage: z.boolean().optional().describe('Take full-page screenshot (for "screenshot" action)'),
      }),
    },
  );
}
