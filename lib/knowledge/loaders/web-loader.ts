import { CheerioWebBaseLoader } from '@langchain/community/document_loaders/web/cheerio';
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
      const loaderOptions: any = {};

      // Add custom headers if provided
      if (headers) {
        loaderOptions.requestOptions = { headers };
      }

      // Add CSS selector if provided
      if (selector) {
        loaderOptions.selector = selector;
      }

      const loader = new CheerioWebBaseLoader(url, loaderOptions);
      const documents = await loader.load();

      logger.info(`Loaded ${documents.length} document(s) from ${url}`);

      // Add source URL to metadata
      documents.forEach((doc) => {
        doc.metadata.source = url;
        doc.metadata.selector = selector || 'body';
      });

      return documents;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to load web content: ${errorMessage}`);

      // Provide helpful error messages for common issues
      if (errorMessage.includes('404')) {
        throw new Error(`Web page not found (404): ${url}`);
      }
      if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('ETIMEDOUT')) {
        throw new Error(`Network error loading ${url}: ${errorMessage}`);
      }
      if (errorMessage.includes('selector')) {
        throw new Error(`Invalid CSS selector "${selector}": ${errorMessage}`);
      }

      throw new Error(`Failed to load web content from ${url}: ${errorMessage}`);
    }
  }
}
