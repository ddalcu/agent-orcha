import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from 'fs';
import * as net from 'net';
import * as path from 'path';
import { logger } from '../logger.ts';
import { getBinaryPath } from './binary-manager.ts';

export interface ServerOptions {
  modelPath: string;
  mmproj?: string;
  port?: number;
  embedding?: boolean;
  gpuLayers?: number;
  contextSize?: number;
  flashAttn?: boolean;
  threads?: number;
  batchSize?: number;
  ubatchSize?: number;
  cacheTypeK?: string;
  cacheTypeV?: string;
  mlock?: boolean;
  reasoningBudget?: number;
  isCuda?: boolean;
}

const HEALTH_POLL_MS = 500;
const STARTUP_TIMEOUT_MS = 120_000;

// ─── PID file management ──────────────────────────────────────────────────────

function pidDir(baseDir: string): string {
  return path.join(baseDir, '.llama-server', 'pids');
}

function pidFilePath(baseDir: string, role: string): string {
  return path.join(pidDir(baseDir), `${role}.json`);
}

function writePidFile(baseDir: string, role: string, info: { pid: number; port: number; model: string }): void {
  const dir = pidDir(baseDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(pidFilePath(baseDir, role), JSON.stringify(info));
}

function removePidFile(baseDir: string, role: string): void {
  try { unlinkSync(pidFilePath(baseDir, role)); } catch { /* already gone */ }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Kill any orphaned llama-server processes from a previous run.
 * Call this once at startup before launching new servers.
 */
export function killOrphanedServers(baseDir: string): void {
  const dir = pidDir(baseDir);
  if (!existsSync(dir)) return;

  let files: string[];
  try { files = readdirSync(dir); } catch { return; }

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const info = JSON.parse(readFileSync(path.join(dir, file), 'utf-8'));
      if (info.pid && isProcessAlive(info.pid)) {
        logger.warn(`[LlamaServer] Killing orphaned llama-server (PID ${info.pid}, port ${info.port})`);
        try { process.kill(info.pid, 'SIGTERM'); } catch { /* already dead */ }
        // Give it a moment, then force kill
        setTimeout(() => {
          try { if (isProcessAlive(info.pid)) process.kill(info.pid, 'SIGKILL'); } catch { /* gone */ }
        }, 3000);
      }
      unlinkSync(path.join(dir, file));
    } catch { /* corrupt pid file, remove it */
      try { unlinkSync(path.join(dir, file)); } catch { /* ignore */ }
    }
  }
}

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
  private role: string;

  constructor(baseDir: string, isEmbedding = false) {
    this.baseDir = baseDir;
    this.isEmbedding = isEmbedding;
    this.role = isEmbedding ? 'embedding' : 'chat';
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
      '--parallel', '1',
    ];

    if (options.mmproj) args.push('--mmproj', options.mmproj);
    if (options.contextSize) args.push('--ctx-size', String(options.contextSize));
    if (options.flashAttn !== false) args.push('--flash-attn', 'on');
    if (options.threads) args.push('--threads', String(options.threads));
    if (options.batchSize) args.push('--batch-size', String(options.batchSize));
    if (options.ubatchSize) args.push('--ubatch-size', String(options.ubatchSize));
    if (options.cacheTypeK) args.push('--cache-type-k', options.cacheTypeK);
    if (options.cacheTypeV) args.push('--cache-type-v', options.cacheTypeV);
    if (options.mlock) args.push('--mlock');
    if (options.reasoningBudget !== undefined) {
      args.push('--reasoning-format', 'deepseek');
      args.push('--reasoning-budget', String(options.reasoningBudget));
    }
    if (options.embedding || this.isEmbedding) args.push('--embedding');

    logger.info(`[LlamaServer] Starting: ${binaryPath} ${args.join(' ')}`);

    const binDir = path.dirname(binaryPath);
    this.proc = spawn(binaryPath, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        LD_LIBRARY_PATH: `${binDir}:${process.env.LD_LIBRARY_PATH ?? ''}`,
        // Force NVIDIA dGPU on Optimus laptops — without this, CUDA may pick Intel iGPU
        ...(options.isCuda ? { CUDA_VISIBLE_DEVICES: '0' } : {}),
      },
    });

    // Buffer stderr so we can surface it when the process crashes
    const stderrChunks: Buffer[] = [];
    this.proc.stderr?.on('data', (data: Buffer) => { stderrChunks.push(data); });

    this.proc.on('exit', () => {
      this._running = false;
      this._ready = false;
      this.proc = null;
      removePidFile(this.baseDir, this.role);
    });

    this._running = true;
    try {
      await this.waitForReady();
    } catch (err) {
      const stderr = Buffer.concat(stderrChunks).toString().trim();
      if (stderr) logger.error(`[LlamaServer] stderr:\n${stderr}`);
      throw err;
    }
    this._ready = true;
    writePidFile(this.baseDir, this.role, { pid: this.proc!.pid!, port: this._port, model: this._modelPath });

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
