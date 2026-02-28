import * as path from 'path';
import { glob } from 'glob';
import { pathToFileURL } from 'url';
import type { StructuredTool } from '../types/llm-types.ts';
import { logger } from '../logger.ts';
import { wrapSimpleFunction, type SimpleFunctionDefinition } from './simple-function-wrapper.ts';

export interface FunctionMetadata {
  name: string;
  description: string;
  version?: string;
  author?: string;
  tags?: string[];
}

export interface LoadedFunction {
  name: string;
  tool: StructuredTool;
  metadata: FunctionMetadata;
  filePath: string;
}

export class FunctionLoader {
  private functionsDir: string;
  private functions: Map<string, LoadedFunction> = new Map();

  constructor(functionsDir: string) {
    this.functionsDir = functionsDir;
  }

  async loadAll(): Promise<void> {
    try {
      const files = await glob('**/*.function.js', { cwd: this.functionsDir });

      for (const file of files) {
        const filePath = path.join(this.functionsDir, file);
        await this.loadOne(filePath);
      }

      logger.info(`[FunctionLoader] Loaded ${this.functions.size} function(s)`);
    } catch (error) {
      logger.warn('[FunctionLoader] Functions directory not found or error loading functions:', error);
    }
  }

  async loadOne(filePath: string): Promise<LoadedFunction> {
    try {
      const fileUrl = pathToFileURL(filePath).href;
      const module = await import(fileUrl);

      let tool: StructuredTool;
      let metadata: FunctionMetadata;

      // Check if it's a simple function definition
      if (this.isSimpleFunctionDefinition(module.default)) {
        const simpleDef = module.default as SimpleFunctionDefinition;
        tool = wrapSimpleFunction(simpleDef);
        metadata = module.metadata || {
          name: simpleDef.name,
          description: simpleDef.description,
        };
      }
      // Check for advanced StructuredTool format
      else if (module.default || this.hasToolExport(module)) {
        tool = module.default || this.findToolExport(module);
        metadata = module.metadata || {
          name: tool.name,
          description: tool.description,
        };
      } else {
        throw new Error(
          'Function file must export either:\n' +
          '1. A simple function definition as default export, or\n' +
          '2. A StructuredTool (named export ending in "Tool" or default export)'
        );
      }

      const loadedFunction: LoadedFunction = {
        name: metadata.name,
        tool,
        metadata,
        filePath,
      };

      this.functions.set(metadata.name, loadedFunction);
      logger.info(`[FunctionLoader] Loaded function: ${metadata.name}`);

      return loadedFunction;
    } catch (error) {
      logger.error(`[FunctionLoader] Failed to load function from ${filePath}:`, error);
      throw error;
    }
  }

  private isSimpleFunctionDefinition(obj: any): boolean {
    return (
      obj &&
      typeof obj === 'object' &&
      typeof obj.name === 'string' &&
      typeof obj.description === 'string' &&
      typeof obj.execute === 'function'
    );
  }

  private hasToolExport(module: any): boolean {
    return Object.keys(module).some((key) => key.endsWith('Tool'));
  }

  private findToolExport(module: any): StructuredTool {
    // Find the first export that ends with "Tool"
    const toolExport = Object.keys(module).find((key) => key.endsWith('Tool'));
    if (toolExport) {
      return module[toolExport];
    }
    throw new Error('No tool export found (should be named export ending in "Tool" or default export)');
  }

  get(name: string): LoadedFunction | undefined {
    return this.functions.get(name);
  }

  getTool(name: string): StructuredTool | undefined {
    return this.functions.get(name)?.tool;
  }

  list(): LoadedFunction[] {
    return Array.from(this.functions.values());
  }

  names(): string[] {
    return Array.from(this.functions.keys());
  }

  remove(name: string): boolean {
    return this.functions.delete(name);
  }

  nameForPath(absolutePath: string): string | undefined {
    for (const [name, fn] of this.functions) {
      if (path.resolve(fn.filePath) === absolutePath) return name;
    }
    return undefined;
  }

  async reload(name: string): Promise<LoadedFunction> {
    const existing = this.functions.get(name);
    if (!existing) {
      throw new Error(`Function not found: ${name}`);
    }

    this.functions.delete(name);
    return this.loadOne(existing.filePath);
  }
}
