import * as fs from 'fs/promises';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import { ModelsFileSchema, type ModelConfig } from './types.ts';
import { logger } from '../logger.ts';

export class ModelConfigLoader {
  private configs = new Map<string, ModelConfig>();
  private filePath: string;

  constructor(workspaceRoot: string) {
    this.filePath = path.join(workspaceRoot, 'models.yaml');
  }

  async loadAll(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const parsed = ModelsFileSchema.parse(parseYaml(raw));
      this.configs.clear();
      for (const [name, config] of Object.entries(parsed.models)) {
        this.configs.set(name, config);
      }
      logger.info(`[ModelConfigLoader] Loaded ${this.configs.size} model(s) from models.yaml`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.debug('[ModelConfigLoader] No models.yaml found, skipping');
        return;
      }
      logger.error('[ModelConfigLoader] Failed to load models.yaml:', err);
    }
  }

  get(name: string): ModelConfig | undefined {
    return this.configs.get(name);
  }

  list(): Array<{ name: string; config: ModelConfig }> {
    return Array.from(this.configs.entries()).map(([name, config]) => ({ name, config }));
  }

  nameForPath(absolutePath: string): string | null {
    return path.resolve(absolutePath) === path.resolve(this.filePath) ? 'models' : null;
  }
}
