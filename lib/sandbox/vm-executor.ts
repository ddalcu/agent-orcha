import * as vm from 'node:vm';
import { createLogger } from '../logger.ts';
import type { ExecResult } from './types.ts';

const logger = createLogger('VmExecutor');

export class VmExecutor {
  private context: vm.Context | null = null;

  private ensureContext(): vm.Context {
    if (!this.context) {
      const sandbox: Record<string, unknown> = {
        console: this.createConsoleProxy(),
        JSON,
        Math,
        Date,
        parseInt,
        parseFloat,
        isNaN,
        isFinite,
        encodeURIComponent,
        decodeURIComponent,
        encodeURI,
        decodeURI,
        Buffer,
        URL,
        URLSearchParams,
        TextEncoder,
        TextDecoder,
        Array,
        Object,
        String,
        Number,
        Boolean,
        Map,
        Set,
        WeakMap,
        WeakSet,
        Promise,
        RegExp,
        Error,
        TypeError,
        RangeError,
        SyntaxError,
        Symbol,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        atob,
        btoa,
      };

      this.context = vm.createContext(sandbox, {
        name: 'sandbox',
      });

      logger.info('VM context created');
    }
    return this.context;
  }

  private createConsoleProxy(): Pick<Console, 'log' | 'error' | 'warn' | 'info' | 'debug'> {
    return {
      log: (...args: unknown[]) => this.captureOutput(args),
      error: (...args: unknown[]) => this.captureOutput(args),
      warn: (...args: unknown[]) => this.captureOutput(args),
      info: (...args: unknown[]) => this.captureOutput(args),
      debug: (...args: unknown[]) => this.captureOutput(args),
    };
  }

  private outputLines: string[] = [];

  private captureOutput(args: unknown[]): void {
    const line = args
      .map(a => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ');
    this.outputLines.push(line);
  }

  async execute(code: string, timeout = 30_000): Promise<ExecResult> {
    const ctx = this.ensureContext();
    this.outputLines = [];

    const wrapped = `(async () => {\n${code}\n})()`;

    try {
      const script = new vm.Script(wrapped, { filename: 'sandbox.js' });
      const promise = script.runInContext(ctx, { timeout });
      const rawResult = await promise;

      const stdout = this.outputLines.join('\n');
      const result = rawResult !== undefined
        ? (typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult))
        : undefined;

      return { stdout, result };
    } catch (err: unknown) {
      const stdout = this.outputLines.join('\n');
      const message = err instanceof Error ? err.message : String(err);
      return { stdout, error: message };
    }
  }

  reset(): void {
    this.context = null;
    this.outputLines = [];
    logger.info('VM context reset');
  }

  close(): void {
    this.reset();
  }
}
