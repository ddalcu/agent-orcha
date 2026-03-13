import { LlamaCppEngine } from './engines/llama-cpp-engine.ts';
import { MlxServeEngine } from './engines/mlx-serve-engine.ts';
import { ModelManager } from './model-manager.ts';
import type { LocalEngine, EngineStatus } from './engine-interface.ts';

export class EngineRegistry {
  private engines = new Map<string, LocalEngine>();
  private _baseDir = '';

  constructor() {
    this.register(new LlamaCppEngine());
    this.register(new MlxServeEngine());
  }

  register(engine: LocalEngine): void {
    this.engines.set(engine.engineName, engine);
  }

  getEngine(name: string): LocalEngine | undefined {
    return this.engines.get(name);
  }

  getAvailableEngines(): LocalEngine[] {
    return [...this.engines.values()].filter(e => e.isAvailable());
  }

  getAllEngines(): LocalEngine[] {
    return [...this.engines.values()];
  }

  getAllStatus(): Record<string, EngineStatus> {
    const result: Record<string, EngineStatus> = {};
    for (const [name, engine] of this.engines) {
      result[name] = engine.getStatus();
    }
    return result;
  }

  setBaseDir(dir: string): void {
    this._baseDir = dir;
    for (const engine of this.engines.values()) {
      engine.setBaseDir(dir);
    }
  }

  killAllOrphans(): void {
    for (const engine of this.engines.values()) {
      engine.killOrphans();
    }
  }

  async unloadAll(): Promise<void> {
    for (const engine of this.engines.values()) {
      await engine.unloadChat();
      await engine.unloadEmbedding();
    }
  }

  async resolveModelPath(modelName: string): Promise<{ filePath: string; type: 'gguf' | 'mlx' }> {
    const manager = new ModelManager(this._baseDir);
    const result = await manager.findModelFile(modelName);
    if (!result) throw new Error(`Local model "${modelName}" not found. Download it first.`);
    return result;
  }
}

export const engineRegistry = new EngineRegistry();
