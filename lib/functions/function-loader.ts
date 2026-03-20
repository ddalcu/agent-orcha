import * as path from 'path';
import * as fs from 'fs';
import { glob } from 'glob';
import { pathToFileURL } from 'url';
import type { StructuredTool } from '../types/llm-types.ts';
import { logger } from '../logger.ts';
import { isSea } from '../sea/bootstrap.ts';
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

/**
 * Load an ESM function file by transforming its exports into plain JS and evaluating it.
 * Used in SEA binaries where dynamic import() of external files is not supported.
 * Exported for testing — not part of the public API.
 */
export function loadESMDirect(filePath: string): Record<string, any> {
  const source = fs.readFileSync(filePath, 'utf-8');

  // Transform ESM export syntax into plain variable declarations
  const transformed = source
    .replace(/^export\s+default\s+/m, 'var __default = ')
    .replace(/^export\s+const\s+(\w+)/gm, 'var $1');

  const wrapper = transformed +
    '\nreturn { default: typeof __default !== "undefined" ? __default : undefined,' +
    ' metadata: typeof metadata !== "undefined" ? metadata : undefined };';

  const factory = new Function('Buffer', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
    'console', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'process', wrapper);

  return factory(Buffer, URL, URLSearchParams, TextEncoder, TextDecoder,
    console, setTimeout, clearTimeout, setInterval, clearInterval, process);
}

export class FunctionLoader {
  private functionsDir: string;
  private functions: Map<string, LoadedFunction> = new Map();

  constructor(functionsDir: string) {
    this.functionsDir = functionsDir;
  }

  async loadAll(): Promise<void> {
    try {
      const files = await glob('**/*.function.{js,mjs}', { cwd: this.functionsDir });

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
      const module = await this.importModule(filePath);

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
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[FunctionLoader] Failed to load function from ${filePath}: ${msg}`);
      throw error;
    }
  }

  /**
   * Import a function module. Uses native import() first; in SEA mode
   * falls back to evaluating the source directly (no import() needed).
   */
  private async importModule(filePath: string): Promise<Record<string, any>> {
    const fileUrl = pathToFileURL(filePath).href;

    try {
      return await import(fileUrl);
    } catch (importError) {
      if (!isSea()) throw importError;

      const importMsg = importError instanceof Error ? importError.message : String(importError);
      logger.debug(
        `[FunctionLoader] Native import() failed in SEA for ${filePath}: ${importMsg}, using direct eval`
      );

      return loadESMDirect(filePath);
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
