import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { StructuredTool } from '@langchain/core/tools';
import type { DockerManager } from './docker-manager.js';
import type { SandboxConfig } from './types.js';

const MAX_OUTPUT_CHARS = 50_000;

/**
 * Creates a tool that fetches web content using curl + lynx inside the Docker sandbox container.
 * For HTML pages, converts to readable text using lynx. For non-HTML, returns raw content.
 */
export function createSandboxWebFetchTool(
  dockerManager: DockerManager,
  config: SandboxConfig,
): StructuredTool {
  let containerName: string | null = null;

  return tool(
    async ({ url, raw }) => {
      if (!containerName) {
        await dockerManager.ensureImage(config.image);
        containerName = await dockerManager.getOrCreateContainer('default');
      }

      // Validate URL
      try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          return JSON.stringify({ error: 'Only http and https URLs are supported' });
        }
      } catch {
        return JSON.stringify({ error: `Invalid URL: ${url}` });
      }

      const escapedUrl = url.replace(/'/g, "'\\''");

      let command: string;
      if (raw) {
        command = `curl -sS -L -m 15 --max-filesize 2097152 '${escapedUrl}'`;
      } else {
        // Use lynx if available for HTML-to-text, fall back to curl
        command =
          `curl -sS -L -m 15 --max-filesize 2097152 '${escapedUrl}' | ` +
          `(lynx -stdin -dump -width=120 2>/dev/null || cat)`;
      }

      const result = await dockerManager.execInContainer(
        containerName,
        command,
        undefined,
        20_000, // 20s timeout for network operations
      );

      if (result.exitCode !== 0) {
        return JSON.stringify({
          error: result.stderr || `Fetch failed (exit code ${result.exitCode})`,
          url,
        });
      }

      let content = result.stdout;
      const truncated = content.length > MAX_OUTPUT_CHARS;
      if (truncated) {
        content = content.substring(0, MAX_OUTPUT_CHARS);
      }

      return JSON.stringify({
        content,
        url,
        truncated,
      });
    },
    {
      name: 'sandbox_web_fetch',
      description:
        'Fetch the content of a web page or API endpoint from inside the Docker sandbox container. ' +
        'HTML is automatically converted to readable text. Use raw=true for API responses or non-HTML content.',
      schema: z.object({
        url: z
          .string()
          .describe('The URL to fetch (http or https)'),
        raw: z
          .boolean()
          .optional()
          .default(false)
          .describe('Return raw content without HTML-to-text conversion'),
      }),
    },
  );
}

/**
 * Creates a tool that performs web searches using DuckDuckGo inside the Docker sandbox container.
 * Scrapes DuckDuckGo's HTML lite endpoint and parses results with Python.
 */
export function createSandboxWebSearchTool(
  dockerManager: DockerManager,
  config: SandboxConfig,
): StructuredTool {
  let containerName: string | null = null;

  // Python script to parse DuckDuckGo HTML results
  const PARSER_SCRIPT = `
import sys, html, re
from urllib.parse import unquote

raw = sys.stdin.read()
results = []
# DuckDuckGo HTML lite uses <a class="result__a" for result links
# and <a class="result__snippet" for snippets
links = re.findall(r'<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)</a>', raw, re.DOTALL)
snippets = re.findall(r'<a[^>]*class="result__snippet"[^>]*>(.*?)</a>', raw, re.DOTALL)

for i, (href, title) in enumerate(links[:10]):
    title = re.sub(r'<[^>]+>', '', title).strip()
    title = html.unescape(title)
    # DuckDuckGo wraps URLs in a redirect; extract the actual URL
    url_match = re.search(r'uddg=([^&]+)', href)
    url = unquote(url_match.group(1)) if url_match else href
    snippet = ''
    if i < len(snippets):
        snippet = re.sub(r'<[^>]+>', '', snippets[i]).strip()
        snippet = html.unescape(snippet)
    results.append(f"{i+1}. {title}\\n   URL: {url}\\n   {snippet}")

if results:
    print("\\n\\n".join(results))
else:
    print("No results found.")
`.trim();

  return tool(
    async ({ query, num_results }) => {
      if (!containerName) {
        await dockerManager.ensureImage(config.image);
        containerName = await dockerManager.getOrCreateContainer('default');
      }

      const encodedQuery = encodeURIComponent(query);

      // Write the parser script to a temp file in the container
      const scriptB64 = Buffer.from(PARSER_SCRIPT, 'utf-8').toString('base64');
      await dockerManager.execInContainer(
        containerName,
        `echo '${scriptB64}' | base64 -d > /tmp/_ddg_parser.py`,
      );

      const command =
        `curl -sS -L -m 10 ` +
        `-H 'User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' ` +
        `'https://html.duckduckgo.com/html/?q=${encodedQuery}' | ` +
        `python3 /tmp/_ddg_parser.py`;

      const result = await dockerManager.execInContainer(
        containerName,
        command,
        undefined,
        15_000,
      );

      if (result.exitCode !== 0) {
        return JSON.stringify({
          error: result.stderr || `Search failed (exit code ${result.exitCode})`,
          query,
        });
      }

      // Optionally limit results
      let content = result.stdout.trim();
      if (num_results && num_results < 10) {
        const lines = content.split('\n\n');
        content = lines.slice(0, num_results).join('\n\n');
      }

      return JSON.stringify({
        results: content,
        query,
      });
    },
    {
      name: 'sandbox_web_search',
      description:
        'Search the web using DuckDuckGo from inside the Docker sandbox container. ' +
        'Returns titles, URLs, and snippets for the top results.',
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
