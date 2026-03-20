import { execFile, execFileSync } from 'node:child_process';
import { logger } from '../logger.ts';

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

  /**
   * Detect if Docker (or compatible runtime) is available.
   */
  detectDocker(): boolean {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const isWin = process.platform === 'win32';
    const candidates = isWin
      ? [
          `${process.env.ProgramFiles || 'C:\\Program Files'}\\Docker\\Docker\\resources\\bin\\docker.exe`,
          `${home}\\.docker\\bin\\docker.exe`,
          'docker',
        ]
      : [
          '/usr/local/bin/docker',
          '/usr/bin/docker',
          `${home}/.docker/bin/docker`,
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
   * Start the sandbox container by pulling and running the published image.
   */
  async start(): Promise<boolean> {
    if (!this.dockerPath) {
      logger.warn('[Sandbox] Docker not detected — sandbox container not available');
      return false;
    }

    if (this.isContainerRunning()) {
      logger.info('[Sandbox] Container already running');
      this.running = true;
      return true;
    }

    logger.info(`[Sandbox] Pulling ${SANDBOX_IMAGE}...`);

    const pulled = await this.pullImage(SANDBOX_IMAGE);
    if (!pulled) {
      logger.error('[Sandbox] Failed to pull sandbox image');
      return false;
    }

    logger.info('[Sandbox] Starting sandbox container...');

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
          resolve(false);
          return;
        }

        this.waitForCDP().then((ready) => {
          if (ready) {
            logger.info('[Sandbox] Container ready (CDP: localhost:9222, VNC: localhost:6080)');
            this.running = true;
          } else {
            logger.warn('[Sandbox] Container started but CDP not responding');
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
   * get a minimal environment that may lack PATH entries and DOCKER_HOST.
   */
  private dockerEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };

    if (!env.DOCKER_HOST) {
      if (process.platform === 'win32') {
        // Docker Desktop on Windows uses a named pipe
        env.DOCKER_HOST = 'npipe:////./pipe/docker_engine';
      } else {
        const home = env.HOME || '';
        const candidates = [
          `${home}/.docker/run/docker.sock`,
          '/var/run/docker.sock',
        ];
        for (const sock of candidates) {
          try {
            require('fs').accessSync(sock);
            env.DOCKER_HOST = `unix://${sock}`;
            break;
          } catch { /* not found */ }
        }
      }
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
