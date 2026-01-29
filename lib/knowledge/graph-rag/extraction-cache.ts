import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import type { CachedGraphData, CacheMetadata, ExtractedEntity, ExtractedRelationship, Community } from './types.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('ExtractionCache');

const CONFIG_VERSION = '1.0';

/**
 * File-based JSON cache for graph extraction results.
 * Invalidates when source document content changes (SHA-256 hash).
 */
export class ExtractionCache {
  private cacheDir: string;

  constructor(baseDir: string, knowledgeName: string) {
    this.cacheDir = path.join(baseDir, knowledgeName);
  }

  /**
   * Compute SHA-256 hash of concatenated document contents.
   */
  static computeSourceHash(documentContents: string[]): string {
    const hash = crypto.createHash('sha256');
    for (const content of documentContents) {
      hash.update(content);
    }
    return hash.digest('hex');
  }

  /**
   * Check if valid cache exists for the given source hash.
   */
  async isValid(sourceHash: string): Promise<boolean> {
    try {
      const metadataPath = path.join(this.cacheDir, 'metadata.json');
      const content = await fs.readFile(metadataPath, 'utf-8');
      const metadata: CacheMetadata = JSON.parse(content);
      return metadata.sourceHash === sourceHash && metadata.configVersion === CONFIG_VERSION;
    } catch {
      return false;
    }
  }

  /**
   * Load cached graph data.
   */
  async load(): Promise<CachedGraphData> {
    const [metadataRaw, entitiesRaw, relationshipsRaw, communitiesRaw] = await Promise.all([
      fs.readFile(path.join(this.cacheDir, 'metadata.json'), 'utf-8'),
      fs.readFile(path.join(this.cacheDir, 'entities.json'), 'utf-8'),
      fs.readFile(path.join(this.cacheDir, 'relationships.json'), 'utf-8'),
      fs.readFile(path.join(this.cacheDir, 'communities.json'), 'utf-8'),
    ]);

    return {
      metadata: JSON.parse(metadataRaw),
      entities: JSON.parse(entitiesRaw),
      relationships: JSON.parse(relationshipsRaw),
      communities: JSON.parse(communitiesRaw),
    };
  }

  /**
   * Save graph data to cache.
   */
  async save(
    sourceHash: string,
    entities: ExtractedEntity[],
    relationships: ExtractedRelationship[],
    communities: Community[]
  ): Promise<void> {
    await fs.mkdir(this.cacheDir, { recursive: true });

    const metadata: CacheMetadata = {
      sourceHash,
      extractedAt: new Date().toISOString(),
      configVersion: CONFIG_VERSION,
    };

    await Promise.all([
      fs.writeFile(path.join(this.cacheDir, 'metadata.json'), JSON.stringify(metadata, null, 2)),
      fs.writeFile(path.join(this.cacheDir, 'entities.json'), JSON.stringify(entities, null, 2)),
      fs.writeFile(path.join(this.cacheDir, 'relationships.json'), JSON.stringify(relationships, null, 2)),
      fs.writeFile(path.join(this.cacheDir, 'communities.json'), JSON.stringify(communities, null, 2)),
    ]);

    logger.info(`Cache saved to ${this.cacheDir} (${entities.length} entities, ${relationships.length} relationships, ${communities.length} communities)`);
  }

  /**
   * Clear the cache directory.
   */
  async clear(): Promise<void> {
    try {
      await fs.rm(this.cacheDir, { recursive: true, force: true });
      logger.info(`Cache cleared: ${this.cacheDir}`);
    } catch {
      // Cache directory may not exist
    }
  }
}
