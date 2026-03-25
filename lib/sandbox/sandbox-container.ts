import { execFile, execFileSync } from 'node:child_process';
import { logger } from '../logger.ts';
import type { SandboxStatus } from './types.ts';

const CONTAINER_NAME = 'orcha-sandbox';
const SANDBOX_IMAGE = 'ddalcu/agent-orcha-sandbox:latest';

/**
 * Manages the standalone sandbox Docker container.
 * Pulls the published sandbox image and runs it via `docker run`.
 * Works both in development and when installed via npm.
 */
export class SandboxContainer {
  private dockerPath: string | null = null;
  private running = false;
  private _status: SandboxStatus = 'idle';
  private _error: string | null = null;

  /**
   * Detect if Docker (or compatible runtime) is available.
   */
  detectDocker(): boolean {
    this._status = 'detecting';
    const isWin = process.platform === 'win32';
    // Avoid accessing ~/.docker/ — macOS treats it as another app's data and shows a privacy prompt.
    const candidates = isWin
      ? [
          `${process.env.ProgramFiles || 'C:\\Program Files'}\\Docker\\Docker\\resources\\bin\\docker.exe`,
          'docker',
        ]
      : [
          '/usr/local/bin/docker',
          '/usr/bin/docker',
          '/Applications/Docker.app/Contents/Resources/bin/docker',
          '/opt/homebrew/bin/docker',
          'docker',
        ];

    for (const candidate of candidates) {
      try {
        execFileSync(candidate, ['version'], { stdio: 'pipe', timeout: 5000, env: this.dockerEnv() });
        this.dockerPath = candidate;
        return true;
      } catch {
        // Not found or not working
      }
    }

    this._status = 'no-docker';
    this._error = 'Docker not detected';
    return false;
  }

  /**
   * Check if the sandbox container is already running.
   */
  isContainerRunning(): boolean {
    if (!this.dockerPath) return false;

    try {
      const output = execFileSync(this.dockerPath, [
        'container', 'inspect', '-f', '{{.State.Running}}', CONTAINER_NAME,
      ], { stdio: 'pipe', timeout: 5000, env: this.dockerEnv() }).toString().trim();
      return output === 'true';
    } catch {
      return false;
    }
  }

  /**
   * Check if the sandbox container exists (running or stopped).
   */
  private containerExists(): boolean {
    if (!this.dockerPath) return false;

    try {
      execFileSync(this.dockerPath, [
        'container', 'inspect', CONTAINER_NAME,
      ], { stdio: 'pipe', timeout: 5000, env: this.dockerEnv() });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Start an existing stopped container.
   */
  private startExistingContainer(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile(this.dockerPath!, [
        'start', CONTAINER_NAME,
      ], { timeout: 30_000, env: this.dockerEnv() }, (error) => {
        if (error) {
          logger.error(`[Sandbox] Failed to start existing container: ${error.message}`);
          resolve(false);
          return;
        }
        this.waitForCDP().then((ready) => {
          if (ready) {
            logger.info('[Sandbox] Container ready (CDP: localhost:9222, VNC: localhost:6080)');
            this.running = true;
            this._status = 'running';
            this._error = null;
          } else {
            logger.warn('[Sandbox] Container started but CDP not responding');
            this._status = 'failed';
            this._error = 'Container started but CDP not responding';
          }
          resolve(ready);
        });
      });
    });
  }

  /**
   * Start the sandbox container by pulling and running the published image.
   */
  async start(): Promise<boolean> {
    if (!this.dockerPath) {
      logger.warn('[Sandbox] Docker not detected — sandbox container not available');
      this._status = 'no-docker';
      this._error = 'Docker not detected';
      return false;
    }

    if (this.isContainerRunning()) {
      logger.info('[Sandbox] Container already running');
      this.running = true;
      this._status = 'running';
      this._error = null;
      return true;
    }

    // If the container exists but is stopped, restart it
    if (this.containerExists()) {
      logger.info('[Sandbox] Restarting existing container...');
      this._status = 'starting';
      return this.startExistingContainer();
    }

    logger.info(`[Sandbox] Pulling ${SANDBOX_IMAGE}...`);
    this._status = 'pulling';

    const pulled = await this.pullImage(SANDBOX_IMAGE);
    if (!pulled) {
      logger.error('[Sandbox] Failed to pull sandbox image');
      this._status = 'failed';
      this._error = 'Failed to pull sandbox image';
      return false;
    }

    logger.info('[Sandbox] Starting sandbox container...');
    this._status = 'starting';

    return new Promise((resolve) => {
      execFile(this.dockerPath!, [
        'run', '-d',
        '--name', CONTAINER_NAME,
        '-p', '9222:9223',
        '-p', '6080:6080',
        '--shm-size', '2g',
        '--cap-add', 'SYS_ADMIN',
        '--restart', 'unless-stopped',
        SANDBOX_IMAGE,
      ], { timeout: 30_000, env: this.dockerEnv() }, (error, _stdout, stderr) => {
        if (error) {
          logger.error(`[Sandbox] Failed to start container: ${error.message}`);
          if (stderr) logger.error(`[Sandbox] ${stderr}`);
          this._status = 'failed';
          this._error = error.message;
          resolve(false);
          return;
        }

        this.waitForCDP().then((ready) => {
          if (ready) {
            logger.info('[Sandbox] Container ready (CDP: localhost:9222, VNC: localhost:6080)');
            this.running = true;
            this._status = 'running';
            this._error = null;
          } else {
            logger.warn('[Sandbox] Container started but CDP not responding');
            this._status = 'failed';
            this._error = 'Container started but CDP not responding';
          }
          resolve(ready);
        });
      });
    });
  }

  /**
   * Stop and remove the sandbox container.
   */
  async stop(): Promise<void> {
    if (!this.dockerPath || !this.running) return;

    return new Promise((resolve) => {
      execFile(this.dockerPath!, [
        'rm', '-f', CONTAINER_NAME,
      ], { timeout: 30_000, env: this.dockerEnv() }, (error) => {
        if (error) {
          logger.warn(`[Sandbox] Failed to stop container: ${error.message}`);
        } else {
          logger.info('[Sandbox] Container stopped');
        }
        this.running = false;
        resolve();
      });
    });
  }

  /**
   * Execute a shell command inside the sandbox container.
   */
  exec(command: string, timeout: number): Promise<{ stdout: string; stderr: string; exitCode: number; error?: string }> {
    return new Promise((resolve) => {
      if (!this.dockerPath || !this.running) {
        resolve({ stdout: '', stderr: '', exitCode: -1, error: 'Sandbox container not running' });
        return;
      }

      execFile(this.dockerPath!, [
        'exec', CONTAINER_NAME,
        'su', '-s', '/bin/sh', 'sandbox', '-c', command,
      ], { timeout, maxBuffer: 10 * 1024 * 1024, env: this.dockerEnv() }, (error, stdout, stderr) => {
        let exitCode = 0;
        if (error && 'code' in error && typeof error.code === 'number') {
          exitCode = error.code;
        } else if (error) {
          exitCode = 1;
        }

        resolve({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          exitCode,
          ...(error && typeof error.code !== 'number' ? { error: error.message } : {}),
        });
      });
    });
  }

  get isRunning(): boolean {
    return this.running;
  }

  get docker(): string | null {
    return this.dockerPath;
  }

  get status(): SandboxStatus {
    return this._status;
  }

  get error(): string | null {
    return this._error;
  }

  private pullImage(image: string): Promise<boolean> {
    return new Promise((resolve) => {
      execFile(this.dockerPath!, ['pull', image], {
        timeout: 120_000,
        env: this.dockerEnv(),
      }, (error, _stdout, stderr) => {
        if (error) {
          logger.error(`[Sandbox] Pull failed: ${error.message}`);
          if (stderr) logger.debug(`[Sandbox] ${stderr.trim()}`);
        }
        resolve(!error);
      });
    });
  }

  /**
   * Build env for Docker commands. macOS .app bundles and Windows native binaries
   * get a minimal environment that may lack PATH entries.
   * We intentionally do NOT probe for Docker sockets (e.g. ~/.docker/run/docker.sock)
   * because that triggers macOS "would like to access data from other apps" prompts.
   * Docker CLI handles its own socket discovery.
   */
  private dockerEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };

    // Ensure Docker helper binaries (docker-credential-desktop, etc.) are in PATH.
    // Avoid ~/.docker/bin — macOS treats it as another app's data and shows a privacy prompt.
    if (process.platform !== 'win32') {
      const extraPaths = [
        '/usr/local/bin',
        '/opt/homebrew/bin',
        '/Applications/Docker.app/Contents/Resources/bin',
      ];
      const current = env.PATH || '';
      const missing = extraPaths.filter(p => !current.includes(p));
      if (missing.length) env.PATH = [...missing, current].join(':');
    }

    // Only set DOCKER_HOST for Windows where the default named pipe isn't auto-discovered.
    // On macOS/Linux, Docker CLI finds its own socket — probing ~/.docker/ triggers macOS privacy prompts.
    if (!env.DOCKER_HOST && process.platform === 'win32') {
      env.DOCKER_HOST = 'npipe:////./pipe/docker_engine';
    }

    return env;
  }

  private async waitForCDP(maxWait = 15_000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      try {
        const response = await fetch('http://localhost:9222/json/version');
        if (response.ok) return true;
      } catch {
        // Not ready yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }
}
