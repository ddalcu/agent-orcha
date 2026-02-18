import * as cheerio from 'cheerio';
import { Document } from '@langchain/core/documents';
import type { WebSourceConfig } from '../types.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('WebLoader');

/**
 * Web scraping document loader using Cheerio.
 * Supports CSS selectors for targeted content extraction.
 */
export class WebLoader {
  private config: WebSourceConfig;

  constructor(config: WebSourceConfig) {
    this.config = config;
  }

  async load(): Promise<Document[]> {
    const { url, selector, headers } = this.config;

    logger.info(`Loading documents from web: ${url}`);
    if (selector) {
      logger.info(`Using CSS selector: ${selector}`);
    }

    try {
      const fetchOptions: RequestInit = {};
      if (headers) {
        fetchOptions.headers = headers;
      }

      const response = await fetch(url, fetchOptions);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const html = await response.text();
      const $ = cheerio.load(html);

      // Remove script and style elements
      $('script, style').remove();

      const target = selector || 'body';
      const text = $(target).text().replace(/\s+/g, ' ').trim();

      if (!text) {
        logger.warn(`No text content found for selector "${target}" at ${url}`);
        return [];
      }

      logger.info(`Loaded 1 document from ${url}`);

      return [new Document({
        pageContent: text,
        metadata: { source: url, selector: target },
      })];
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
}
