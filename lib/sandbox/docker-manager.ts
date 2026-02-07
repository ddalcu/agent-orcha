import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { SandboxConfig, ContainerInfo, ExecResult } from './types.js';
import { createLogger } from '../logger.js';

const logger = createLogger('DockerManager');

export class DockerManager {
  private containers = new Map<string, ContainerInfo>();
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private config: SandboxConfig) {}

  /**
   * Pull the Docker image if it's not already present locally.
   */
  async ensureImage(image: string): Promise<void> {
    try {
      await this.docker(['image', 'inspect', image]);
      logger.info(`Image "${image}" already present`);
    } catch {
      logger.info(`Pulling image "${image}"...`);
      await this.docker(['pull', image]);
      logger.info(`Image "${image}" pulled`);
    }
  }

  /**
   * Get an existing container for the scope key or create a new one.
   */
  async getOrCreateContainer(scopeKey: string): Promise<string> {
    const name = `${this.config.containerPrefix}${scopeKey}`;
    const existing = this.containers.get(name);

    if (existing) {
      const currentHash = this.configHash();
      if (existing.configHash !== currentHash) {
        logger.info(`Config changed for "${name}", recreating container`);
        await this.removeContainer(name);
      } else {
        existing.lastUsedAt = Date.now();
        await this.startContainer(name);
        return name;
      }
    }

    // Check if the container already exists in Docker (from a previous session)
    try {
      const inspectOut = await this.docker([
        'inspect', '--format', '{{.Id}}', name,
      ]);
      const containerId = inspectOut.trim();
      this.containers.set(name, {
        containerName: name,
        containerId,
        status: 'created',
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        configHash: this.configHash(),
      });
      await this.startContainer(name);
      return name;
    } catch {
      // Container doesn't exist, create it
    }

    await this.createContainer(name);
    await this.startContainer(name);
    await this.runInitCommands(name);
    return name;
  }

  /**
   * Create a Docker container with the configured resource limits and security settings.
   */
  private async createContainer(name: string): Promise<void> {
    const args: string[] = ['create', '--name', name];

    // Resource limits
    args.push('--memory', this.config.memory);
    args.push('--cpus', String(this.config.cpus));
    args.push('--pids-limit', String(this.config.pidsLimit));

    // Network
    args.push('--network', this.config.network);

    // Working directory
    args.push('--workdir', this.config.workdir);

    // Capability drops
    for (const cap of this.config.capDrop) {
      args.push('--cap-drop', cap);
    }

    // Capability adds
    for (const cap of this.config.capAdd) {
      args.push('--cap-add', cap);
    }

    // DNS servers
    for (const dns of this.config.dns) {
      args.push('--dns', dns);
    }

    // Environment variables
    for (const [key, value] of Object.entries(this.config.env)) {
      args.push('--env', `${key}=${value}`);
    }

    // Volume binds
    for (const bind of this.config.binds) {
      args.push('--volume', bind);
    }

    // Keep container alive with a sleep loop
    args.push(this.config.image, 'sleep', 'infinity');

    const output = await this.docker(args);
    const containerId = output.trim();

    this.containers.set(name, {
      containerName: name,
      containerId,
      status: 'created',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      configHash: this.configHash(),
    });

    logger.info(`Container "${name}" created (${containerId.slice(0, 12)})`);
  }

  /**
   * Start a container if it's not already running.
   */
  async startContainer(name: string): Promise<void> {
    try {
      const stateOut = await this.docker([
        'inspect', '--format', '{{.State.Running}}', name,
      ]);
      if (stateOut.trim() === 'true') {
        return;
      }
    } catch {
      // Container might not exist — caller handles this
      throw new Error(`Container "${name}" does not exist`);
    }

    await this.docker(['start', name]);
    const info = this.containers.get(name);
    if (info) {
      info.status = 'running';
    }
    logger.info(`Container "${name}" started`);
  }

  /**
   * Run configured init commands inside a newly created container.
   */
  private async runInitCommands(name: string): Promise<void> {
    if (this.config.initCommands.length === 0) return;

    logger.info(`Running ${this.config.initCommands.length} init command(s) in "${name}"...`);
    for (const cmd of this.config.initCommands) {
      try {
        await this.execInContainer(name, cmd, undefined, 300_000); // 5min timeout for installs
        logger.info(`Init command succeeded: ${cmd.slice(0, 80)}`);
      } catch (err) {
        logger.warn(`Init command failed: ${cmd.slice(0, 80)}`, err);
      }
    }
  }

  /**
   * Execute a command inside a running container.
   */
  async execInContainer(
    name: string,
    command: string,
    workdir?: string,
    timeout?: number,
  ): Promise<ExecResult> {
    const effectiveTimeout = timeout ?? this.config.commandTimeout;

    const args: string[] = ['exec'];
    if (workdir) {
      args.push('--workdir', workdir);
    }
    args.push(name, 'sh', '-c', command);

    const info = this.containers.get(name);
    if (info) {
      info.lastUsedAt = Date.now();
    }

    try {
      const stdout = await this.docker(args, effectiveTimeout);
      return { stdout, stderr: '', exitCode: 0 };
    } catch (err: unknown) {
      if (isExecError(err)) {
        return {
          stdout: err.stdout ?? '',
          stderr: err.stderr ?? '',
          exitCode: err.code ?? 1,
        };
      }
      throw err;
    }
  }

  /**
   * Forcefully remove a container.
   */
  async removeContainer(name: string): Promise<void> {
    try {
      await this.docker(['rm', '-f', name]);
      this.containers.delete(name);
      logger.info(`Container "${name}" removed`);
    } catch (err) {
      logger.warn(`Failed to remove container "${name}":`, err);
    }
  }

  /**
   * List containers matching the configured prefix.
   */
  async listContainers(): Promise<string[]> {
    try {
      const output = await this.docker([
        'ps', '-a', '--filter', `name=${this.config.containerPrefix}`,
        '--format', '{{.Names}}',
      ]);
      return output.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Remove containers that have been idle longer than idleTimeout or older than maxAge.
   */
  async pruneIdleContainers(): Promise<void> {
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [name, info] of this.containers) {
      const idleMs = now - info.lastUsedAt;
      const ageMs = now - info.createdAt;

      if (idleMs > this.config.idleTimeout || ageMs > this.config.maxAge) {
        toRemove.push(name);
      }
    }

    for (const name of toRemove) {
      await this.removeContainer(name);
    }

    if (toRemove.length > 0) {
      logger.info(`Pruned ${toRemove.length} idle container(s)`);
    }
  }

  /**
   * Start periodic pruning of idle containers.
   */
  startPruning(intervalMs = 60_000): void {
    if (this.pruneTimer) return;
    this.pruneTimer = setInterval(() => {
      this.pruneIdleContainers().catch((err) =>
        logger.warn('Prune error:', err)
      );
    }, intervalMs);
  }

  /**
   * Stop the prune timer and remove all managed containers.
   */
  async close(): Promise<void> {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }

    const names = Array.from(this.containers.keys());
    for (const name of names) {
      await this.removeContainer(name);
    }
  }

  private configHash(): string {
    return createHash('sha256')
      .update(JSON.stringify(this.config))
      .digest('hex')
      .slice(0, 12);
  }

  private docker(args: string[], timeout = 120_000): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('docker', args, { timeout }, (error, stdout, stderr) => {
        if (error) {
          const execError = error as ExecFileError;
          execError.stdout = stdout;
          execError.stderr = stderr;
          reject(execError);
          return;
        }
        resolve(stdout);
      });
    });
  }
}

interface ExecFileError extends Error {
  code?: number;
  stdout?: string;
  stderr?: string;
}

function isExecError(err: unknown): err is ExecFileError {
  return err instanceof Error && ('code' in err || 'stderr' in err);
}
