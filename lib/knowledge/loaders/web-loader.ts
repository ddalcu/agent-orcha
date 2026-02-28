import * as cheerio from 'cheerio';
import type { Document } from '../../types/llm-types.ts';
import type { WebSourceConfig } from '../types.ts';
import { parseJsonContent, parseCsvContent } from './file-loaders.ts';
import { createLogger } from '../../logger.ts';

const logger = createLogger('WebLoader');

/**
 * Web document loader. Fetches content from a URL and parses it
 * based on the configured loader type.
 *
 * Supported loader types:
 * - html (default): Cheerio HTML parsing with optional CSS selector
 * - text / markdown: Raw text content
 * - json: JSON string extraction
 * - csv: CSV row parsing
 */
export class WebLoader {
  private config: WebSourceConfig;
  private loaderType: string;

  constructor(config: WebSourceConfig, loaderType: string = 'html') {
    this.config = config;
    this.loaderType = loaderType;
  }

  async load(): Promise<Document[]> {
    const { url, headers } = this.config;

    logger.info(`Loading from ${url} (type: ${this.loaderType})`);

    try {
      const fetchOptions: RequestInit = {};
      if (headers) {
        fetchOptions.headers = headers;
      }

      const response = await fetch(url, fetchOptions);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const content = await response.text();

      switch (this.loaderType) {
        case 'json':
          return parseJsonContent(this.extractJsonPath(content), url);

        case 'csv':
          return parseCsvContent(content, url);

        case 'text':
        case 'markdown':
          return content.trim()
            ? [{ pageContent: content.trim(), metadata: { source: url } }]
            : [];

        case 'html':
        default:
          return this.parseHtml(content, url);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to load web content: ${errorMessage}`);

      if (errorMessage.includes('404')) {
        throw new Error(`Web page not found (404): ${url}`);
      }
      if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('ETIMEDOUT')) {
        throw new Error(`Network error loading ${url}: ${errorMessage}`);
      }

      throw new Error(`Failed to load web content from ${url}: ${errorMessage}`);
    }
  }

  private extractJsonPath(content: string): string {
    const { jsonPath } = this.config;
    if (!jsonPath) return content;

    const data = JSON.parse(content);
    const value = jsonPath.split('.').reduce((obj: any, key) => obj?.[key], data);
    if (value === undefined) {
      throw new Error(`jsonPath "${jsonPath}" not found in response`);
    }

    logger.info(`Extracted jsonPath "${jsonPath}" (${Array.isArray(value) ? value.length + ' items' : typeof value})`);
    return JSON.stringify(value);
  }

  private parseHtml(html: string, url: string): Document[] {
    const { selector } = this.config;
    const $ = cheerio.load(html);

    $('script, style').remove();

    const target = selector || 'body';
    if (selector) {
      logger.info(`Using CSS selector: ${selector}`);
    }

    const text = $(target).text().replace(/\s+/g, ' ').trim();

    if (!text) {
      logger.warn(`No text content found for selector "${target}" at ${url}`);
      return [];
    }

    logger.info(`Loaded 1 document from ${url}`);
    return [{ pageContent: text, metadata: { source: url, selector: target } }];
  }
}
