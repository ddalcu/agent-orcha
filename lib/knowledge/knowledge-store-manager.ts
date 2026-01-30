import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';
import { parse as parseYaml } from 'yaml';
import { KnowledgeConfigSchema, type KnowledgeConfig, type VectorKnowledgeConfig, type GraphRagKnowledgeConfig, type KnowledgeStoreInstance } from './types.js';
import { KnowledgeStoreFactory } from './knowledge-store-factory.js';
import { GraphRagFactory } from './graph-rag/graph-rag-factory.js';
import { createLogger } from '../logger.js';

const logger = createLogger('KnowledgeStore');

export class KnowledgeStoreManager {
  private knowledgeDir: string;
  private projectRoot: string;
  private stores: Map<string, KnowledgeStoreInstance> = new Map();
  private configs: Map<string, KnowledgeConfig> = new Map();

  constructor(knowledgeDir: string, projectRoot: string) {
    this.knowledgeDir = knowledgeDir;
    this.projectRoot = projectRoot;
  }

  async loadAll(): Promise<void> {
    const files = await glob('**/*.knowledge.yaml', { cwd: this.knowledgeDir });

    for (const file of files) {
      const filePath = path.join(this.knowledgeDir, file);
      await this.loadOne(filePath);
    }
  }

  async loadOne(filePath: string): Promise<KnowledgeConfig> {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = parseYaml(content);
    const config = KnowledgeConfigSchema.parse(parsed);
    this.configs.set(config.name, config);
    return config;
  }

  async initialize(name: string): Promise<KnowledgeStoreInstance> {
    const existing = this.stores.get(name);
    if (existing) {
      logger.info(`"${name}" already initialized`);
      return existing;
    }

    const config = this.configs.get(name);
    if (!config) {
      throw new Error(`Knowledge config not found: ${name}`);
    }

    logger.info(`Initializing "${name}" (kind: ${config.kind})...`);

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
      let store: KnowledgeStoreInstance;

      if (config.kind === 'graph-rag') {
        store = await GraphRagFactory.create(config as GraphRagKnowledgeConfig, this.projectRoot);
      } else {
        store = await KnowledgeStoreFactory.create(config as VectorKnowledgeConfig, this.projectRoot);
      }

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

  get(name: string): KnowledgeStoreInstance | undefined {
    return this.stores.get(name);
  }

  getConfig(name: string): KnowledgeConfig | undefined {
    return this.configs.get(name);
  }

  list(): KnowledgeStoreInstance[] {
    return Array.from(this.stores.values());
  }

  listConfigs(): KnowledgeConfig[] {
    return Array.from(this.configs.values());
  }

  async refresh(name: string): Promise<void> {
    const store = this.stores.get(name);
    if (store) {
      await store.refresh();
    }
  }
}
