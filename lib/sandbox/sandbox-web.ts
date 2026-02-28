import { tool } from '../types/tool-factory.ts';
import { z } from 'zod';
import { JSDOM, VirtualConsole } from 'jsdom';
import { htmlToMarkdown } from './html-to-markdown.ts';
import { createLogger } from '../logger.ts';
import type { StructuredTool } from '../types/llm-types.ts';
import type { SandboxConfig } from './types.ts';

const logger = createLogger('Sandbox');

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

export function createSandboxWebFetchTool(config: SandboxConfig): StructuredTool {
  return tool(
    async ({ url, raw, runScripts }) => {
      try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          return JSON.stringify({ error: 'Only http and https URLs are supported' });
        }
      } catch {
        return JSON.stringify({ error: `Invalid URL: ${url}` });
      }

      logger.info(`[web_fetch] ${url}`);

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);

        const response = await fetch(url, {
          headers: BROWSER_HEADERS,
          signal: controller.signal,
          redirect: 'follow',
        });
        clearTimeout(timer);

        logger.info(`[web_fetch] ${response.status} ${response.url} (${response.headers.get('content-type') ?? 'unknown'})`);

        const body = await response.text();

        if (raw) {
          const truncated = body.length > config.maxOutputChars;
          return JSON.stringify({
            content: truncated ? body.substring(0, config.maxOutputChars) : body,
            url: response.url,
            status: response.status,
            truncated,
          });
        }

        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.includes('html')) {
          const truncated = body.length > config.maxOutputChars;
          return JSON.stringify({
            content: truncated ? body.substring(0, config.maxOutputChars) : body,
            url: response.url,
            status: response.status,
            truncated,
          });
        }

        let html = body;
        if (runScripts) {
          try {
            const virtualConsole = new VirtualConsole();
            virtualConsole.on('jsdomError', () => { /* suppress script errors */ });
            const dom = new JSDOM(body, {
              url: response.url,
              runScripts: 'dangerously',
              pretendToBeVisual: true,
              virtualConsole,
            });
            // Catch uncaught errors inside the jsdom window (e.g. dynamic import())
            dom.window.addEventListener('error', (e: Event) => e.preventDefault());
            await new Promise(r => setTimeout(r, 100));
            html = dom.serialize();
            dom.window.close();
          } catch {
            // Script execution failed entirely — fall back to raw HTML
          }
        }

        let content = htmlToMarkdown(html);
        const truncated = content.length > config.maxOutputChars;
        if (truncated) {
          content = content.substring(0, config.maxOutputChars);
        }

        return JSON.stringify({
          content,
          url: response.url,
          status: response.status,
          truncated,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[web_fetch] Error: ${message}`);
        return JSON.stringify({ error: message, url });
      }
    },
    {
      name: 'sandbox_web_fetch',
      description:
        'Fetch the content of a web page or API endpoint. ' +
        'HTML is automatically converted to clean markdown. Use raw=true for API responses or non-HTML content. ' +
        'Set runScripts=true to execute page JavaScript before extraction (may fail on some sites).',
      schema: z.object({
        url: z
          .string()
          .describe('The URL to fetch (http or https)'),
        raw: z
          .boolean()
          .optional()
          .default(false)
          .describe('Return raw content without HTML-to-markdown conversion'),
        runScripts: z
          .boolean()
          .optional()
          .default(false)
          .describe('Run page JavaScript before extracting content (default: false). May fail on pages with dynamic imports.'),
      }),
    },
  );
}

export function createSandboxWebSearchTool(): StructuredTool {
  return tool(
    async ({ query, num_results }) => {
      logger.info(`[web_search] "${query}"`);

      const encodedQuery = encodeURIComponent(query);
      const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);

        const response = await fetch(url, {
          headers: BROWSER_HEADERS,
          signal: controller.signal,
          redirect: 'follow',
        });
        clearTimeout(timer);

        logger.info(`[web_search] ${response.status} (${query})`);

        if (response.status !== 200) {
          return JSON.stringify({
            error: `Search request failed with status ${response.status}. Do not retry.`,
            query,
          });
        }

        const html = await response.text();

        // Detect CAPTCHA/block pages
        if (html.includes('bot') && html.includes('captcha') || html.includes('blocked')) {
          logger.warn(`[web_search] Blocked by DuckDuckGo for query: "${query}"`);
          return JSON.stringify({
            error: 'Search blocked by DuckDuckGo (rate limited or CAPTCHA). Do not retry — use sandbox_web_fetch to access specific URLs directly instead.',
            query,
          });
        }

        const results = parseDuckDuckGoResults(html, num_results ?? 10);
        const resultCount = results.startsWith('No results') ? 0 : results.split('\n\n').length;
        logger.info(`[web_search] ${resultCount} result(s) for "${query}"`);

        return JSON.stringify({ results, query });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[web_search] Error: ${message}`);
        return JSON.stringify({
          error: `${message}. Do not retry with the same query.`,
          query,
        });
      }
    },
    {
      name: 'sandbox_web_search',
      description:
        'Search the web using DuckDuckGo. ' +
        'Returns titles, URLs, and snippets for the top results. ' +
        'If the search returns no results or an error, do NOT retry — report what you found to the user.',
      schema: z.object({
        query: z
          .string()
          .describe('The search query'),
        num_results: z
          .number()
          .optional()
          .describe('Maximum number of results to return (default 10, max 10)'),
      }),
    },
  );
}

function parseDuckDuckGoResults(html: string, maxResults: number): string {
  const linkPattern = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gs;
  const snippetPattern = /<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gs;

  const links: Array<{ href: string; title: string }> = [];
  let match: RegExpExecArray | null;

  while ((match = linkPattern.exec(html)) !== null) {
    const href = match[1]!;
    const title = match[2]!.replace(/<[^>]+>/g, '').trim();
    links.push({ href, title: decodeHTMLEntities(title) });
  }

  const snippets: string[] = [];
  while ((match = snippetPattern.exec(html)) !== null) {
    const snippet = match[1]!.replace(/<[^>]+>/g, '').trim();
    snippets.push(decodeHTMLEntities(snippet));
  }

  const entries: string[] = [];
  const limit = Math.min(links.length, maxResults);
  for (let i = 0; i < limit; i++) {
    const { href, title } = links[i]!;
    const uddgMatch = href.match(/uddg=([^&]+)/);
    const resolvedUrl = uddgMatch ? decodeURIComponent(uddgMatch[1]!) : href;
    const snippet = i < snippets.length ? snippets[i]! : '';
    entries.push(`${i + 1}. [${title}](${resolvedUrl})\n   ${snippet}`);
  }

  return entries.length > 0 ? entries.join('\n\n') : 'No results found. Do not retry — tell the user no results were found for this query.';
}

function decodeHTMLEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}
