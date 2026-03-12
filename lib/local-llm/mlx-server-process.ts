import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from 'fs';
import * as net from 'net';
import * as path from 'path';
import { logger } from '../logger.ts';
import { getMlxBinaryPath } from './mlx-binary-manager.ts';

const HEALTH_POLL_MS = 500;
const STARTUP_TIMEOUT_MS = 120_000;
const MLX_MANUAL = process.env.MLX_MANUAL === 'true';

// ─── PID file management ──────────────────────────────────────────────────────

function pidDir(baseDir: string): string {
  return path.join(baseDir, '.mlx-serve', 'pids');
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

export function killOrphanedMlxServers(baseDir: string): void {
  const dir = pidDir(baseDir);
  if (!existsSync(dir)) return;

  let files: string[];
  try { files = readdirSync(dir); } catch { return; }

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const info = JSON.parse(readFileSync(path.join(dir, file), 'utf-8'));
      if (info.pid && isProcessAlive(info.pid)) {
        logger.warn(`[MlxServer] Killing orphaned mlx-serve (PID ${info.pid}, port ${info.port})`);
        try { process.kill(info.pid, 'SIGTERM'); } catch { /* already dead */ }
        setTimeout(() => {
          try { if (isProcessAlive(info.pid)) process.kill(info.pid, 'SIGKILL'); } catch { /* gone */ }
        }, 3000);
      }
      unlinkSync(path.join(dir, file));
    } catch {
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

export interface MlxServerOptions {
  modelPath: string;
  port?: number;
  contextSize?: number;
  reasoningBudget?: number;
}

export class MlxServerProcess {
  private proc: ChildProcess | null = null;
  private _port = 0;
  private _modelPath = '';
  private _running = false;
  private _ready = false;
  private baseDir: string;
  private role: string;

  constructor(baseDir: string, role: string = 'chat') {
    this.baseDir = baseDir;
    this.role = role;
  }

  get port() { return this._port; }
  get modelPath() { return this._modelPath; }
  get running() { return this._running; }
  get ready() { return this._ready; }

  async start(options: MlxServerOptions): Promise<void> {
    await this.stop();

    const binaryPath = await getMlxBinaryPath(this.baseDir);

    this._port = options.port ?? await findFreePort(9990);
    this._modelPath = options.modelPath;

    const args = [
      '--model', options.modelPath,
      '--serve',
      '--host', '127.0.0.1',
      '--port', String(this._port),
    ];

    if (options.contextSize) {
      args.push('--ctx-size', String(options.contextSize));
    }

    if (options.reasoningBudget !== undefined) {
      args.push('--reasoning-budget', String(options.reasoningBudget));
    }

    if (MLX_MANUAL) {
      // Manual mode: print command for user to start, then poll for readiness
      logger.info(`[MlxServer] Run manually:\n${binaryPath} ${args.join(' ')}`);
      this._running = true;
      await this.waitForReady();
      this._ready = true;
      logger.info(`[MlxServer] Ready on port ${this._port}`);
      return;
    }

    logger.info(`[MlxServer] Starting: ${binaryPath} ${args.join(' ')}`);

    this.proc = spawn(binaryPath, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

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
      if (stderr) logger.error(`[MlxServer] stderr:\n${stderr}`);
      throw err;
    }
    this._ready = true;
    writePidFile(this.baseDir, this.role, { pid: this.proc!.pid!, port: this._port, model: this._modelPath });

    logger.info(`[MlxServer] Ready on port ${this._port}`);
  }

  async stop(): Promise<void> {
    if (MLX_MANUAL) {
      logger.info('[MlxServer] Stopped (manual mode — kill the process yourself)');
      this._running = false;
      this._ready = false;
      return;
    }

    if (!this.proc) return;

    logger.info('[MlxServer] Stopping');
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

  private async waitForReady(): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < STARTUP_TIMEOUT_MS) {
      if (!this._running) throw new Error('mlx-serve process exited during startup');
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
    throw new Error(`mlx-serve failed to become ready within ${STARTUP_TIMEOUT_MS / 1000}s`);
  }
}
