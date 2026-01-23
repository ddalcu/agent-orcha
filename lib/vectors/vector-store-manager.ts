import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';
import { parse as parseYaml } from 'yaml';
import { VectorConfigSchema, type VectorConfig, type VectorStoreInstance } from './types.js';
import { VectorStoreFactory } from './vector-store-factory.js';
import { createLogger } from '../logger.js';

const logger = createLogger('VectorStore');

export class VectorStoreManager {
  private vectorsDir: string;
  private projectRoot: string;
  private stores: Map<string, VectorStoreInstance> = new Map();
  private configs: Map<string, VectorConfig> = new Map();

  constructor(vectorsDir: string, projectRoot: string) {
    this.vectorsDir = vectorsDir;
    this.projectRoot = projectRoot;
  }

  async loadAll(): Promise<void> {
    const files = await glob('**/*.vector.yaml', { cwd: this.vectorsDir });

    for (const file of files) {
      const filePath = path.join(this.vectorsDir, file);
      await this.loadOne(filePath);
    }
  }

  async loadOne(filePath: string): Promise<VectorConfig> {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = parseYaml(content);
    const config = VectorConfigSchema.parse(parsed);
    this.configs.set(config.name, config);
    return config;
  }

  async initialize(name: string): Promise<VectorStoreInstance> {
    const existing = this.stores.get(name);
    if (existing) {
      logger.info(`"${name}" already initialized`);
      return existing;
    }

    const config = this.configs.get(name);
    if (!config) {
      throw new Error(`Vector config not found: ${name}`);
    }

    logger.info(`Initializing "${name}"...`);

    // Log source-specific info
    if (config.source.type === 'directory' || config.source.type === 'file') {
      logger.info(`Source: ${config.source.path}, Pattern: ${'pattern' in config.source ? config.source.pattern || '*' : 'N/A'}`);
    } else if (config.source.type === 'database') {
      logger.info(`Source: database (${config.source.connectionString.split('@')[1] || 'unknown'})`);
    } else if (config.source.type === 'web') {
      logger.info(`Source: web (${config.source.url})`);
    } else if (config.source.type === 's3') {
      logger.info(`Source: s3 (bucket: ${config.source.bucket})`);
    }

    try {
      const store = await VectorStoreFactory.create(config, this.projectRoot);
      this.stores.set(name, store);
      logger.info(`"${name}" initialized successfully`);
      return store;
    } catch (error) {
      logger.error(`Failed to initialize "${name}":`, error);
      throw error;
    }
  }

  async initializeAll(): Promise<void> {
    for (const name of this.configs.keys()) {
      await this.initialize(name);
    }
  }

  get(name: string): VectorStoreInstance | undefined {
    return this.stores.get(name);
  }

  getConfig(name: string): VectorConfig | undefined {
    return this.configs.get(name);
  }

  list(): VectorStoreInstance[] {
    return Array.from(this.stores.values());
  }

  listConfigs(): VectorConfig[] {
    return Array.from(this.configs.values());
  }

  async refresh(name: string): Promise<void> {
    const store = this.stores.get(name);
    if (store) {
      await store.refresh();
    }
  }
}
