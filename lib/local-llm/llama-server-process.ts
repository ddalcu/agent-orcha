import { spawn, type ChildProcess } from 'child_process';
import * as net from 'net';
import { logger } from '../logger.ts';
import { getBinaryPath } from './binary-manager.ts';

export interface ServerOptions {
  modelPath: string;
  port?: number;
  embedding?: boolean;
  gpuLayers?: number;
  contextSize?: number;
  flashAttn?: boolean;
  threads?: number;
  batchSize?: number;
  ubatchSize?: number;
}

const HEALTH_POLL_MS = 500;
const STARTUP_TIMEOUT_MS = 120_000;

async function findFreePort(start: number): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(start, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
    server.on('error', () => findFreePort(start + 1).then(resolve));
  });
}

export class LlamaServerProcess {
  private proc: ChildProcess | null = null;
  private _port = 0;
  private _modelPath = '';
  private _running = false;
  private _ready = false;
  private baseDir: string;
  private isEmbedding: boolean;

  constructor(baseDir: string, isEmbedding = false) {
    this.baseDir = baseDir;
    this.isEmbedding = isEmbedding;
  }

  get port() { return this._port; }
  get modelPath() { return this._modelPath; }
  get running() { return this._running; }
  get ready() { return this._ready; }

  async start(options: ServerOptions): Promise<void> {
    await this.stop();

    const binaryPath = await getBinaryPath(this.baseDir);
    this._port = options.port ?? await findFreePort(this.isEmbedding ? 9991 : 9990);
    this._modelPath = options.modelPath;

    const args = [
      '--model', options.modelPath,
      '--port', String(this._port),
      '--host', '127.0.0.1',
      '--n-gpu-layers', String(options.gpuLayers ?? -1),
    ];

    if (options.contextSize) args.push('--ctx-size', String(options.contextSize));
    if (options.flashAttn !== false) args.push('--flash-attn', 'on');
    if (options.threads) args.push('--threads', String(options.threads));
    if (options.batchSize) args.push('--batch-size', String(options.batchSize));
    if (options.ubatchSize) args.push('--ubatch-size', String(options.ubatchSize));
    if (options.embedding || this.isEmbedding) args.push('--embedding');

    logger.info(`[LlamaServer] Starting: ${binaryPath} ${args.join(' ')}`);

    this.proc = spawn(binaryPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });

    // Buffer stderr so we can log it if the process crashes
    const stderrChunks: Buffer[] = [];
    this.proc.stderr?.on('data', (data: Buffer) => { stderrChunks.push(data); });

    this.proc.on('exit', (code, signal) => {
      if (code && code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString().trim();
        logger.error(`[LlamaServer] Process crashed (code=${code})${stderr ? `:\n${stderr}` : ''}`);
      }
      this._running = false;
      this._ready = false;
      this.proc = null;
    });

    this._running = true;
    await this.waitForReady();
    this._ready = true;

    logger.info(`[LlamaServer] Ready on port ${this._port}`);
  }

  async stop(): Promise<void> {
    if (!this.proc) return;

    logger.info('[LlamaServer] Stopping');
    this.proc.kill('SIGTERM');

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.proc?.kill('SIGKILL');
        resolve();
      }, 5000);

      if (this.proc) {
        this.proc.on('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      } else {
        clearTimeout(timeout);
        resolve();
      }
    });

    this.proc = null;
    this._running = false;
    this._ready = false;
  }

  getBaseUrl(): string {
    return `http://127.0.0.1:${this._port}`;
  }

  async getServerProps(): Promise<any> {
    if (!this._ready) return null;
    try {
      const res = await fetch(`${this.getBaseUrl()}/props`);
      if (res.ok) return res.json();
    } catch { /* server may be down */ }
    return null;
  }


  private async waitForReady(): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < STARTUP_TIMEOUT_MS) {
      if (!this._running) throw new Error('llama-server process exited during startup');
      try {
        const res = await fetch(`http://127.0.0.1:${this._port}/health`);
        if (res.ok) {
          const body: any = await res.json();
          if (body.status === 'ok') return;
        }
      } catch { /* not ready yet */ }
      await new Promise(r => setTimeout(r, HEALTH_POLL_MS));
    }
    await this.stop();
    throw new Error(`llama-server failed to become ready within ${STARTUP_TIMEOUT_MS / 1000}s`);
  }
}
