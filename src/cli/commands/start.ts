import dotenv from 'dotenv';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { isSea, getDefaultWorkspace, extractTemplates } from '../../../lib/sea/bootstrap.ts';
import { createSystemTray, type SystemTray } from '../../../lib/sea/system-tray.ts';

const workspaceRoot = isSea()
  ? (process.env.WORKSPACE ? path.resolve(process.env.WORKSPACE) : getDefaultWorkspace())
  : process.cwd();

// Load .env from the workspace root
const cliEnvPath = path.join(workspaceRoot, '.env');
if (fsSync.existsSync(cliEnvPath)) {
  dotenv.config({ path: cliEnvPath });
} else {
  dotenv.config();
}

import { Orchestrator } from '../../../lib/index.ts';
import { createServer } from '../../server.ts';
import { logger } from '../../../lib/logger.ts';

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(dirPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

async function validateWorkspaceStructure(workspaceRoot: string): Promise<void> {
  const requiredDirs = ['agents', 'functions', 'knowledge', 'workflows'];
  const missingDirs = [];

  for (const dir of requiredDirs) {
    const dirPath = path.join(workspaceRoot, dir);
    if (!(await directoryExists(dirPath))) {
      missingDirs.push(dir);
    }
  }

  if (missingDirs.length > 0) {
    console.error('\nError: Required directories not found in current directory:');
    missingDirs.forEach(dir => console.error(`  - ${dir}/`));
    console.error('\nThis does not appear to be an Agent Orcha workspace.');
    console.error('Run "npx agent-orcha init" to create a new workspace.\n');
    throw new Error('Invalid workspace structure');
  }

  // Check for config files
  const configFiles = ['llm.json', 'mcp.json'];
  const missingConfigs = [];

  for (const file of configFiles) {
    const filePath = path.join(workspaceRoot, file);
    try {
      await fs.access(filePath);
    } catch {
      missingConfigs.push(file);
    }
  }

  if (missingConfigs.includes('llm.json')) {
    console.error('\nWarning: llm.json not found. LLM functionality may not work correctly.');
    console.error('Create llm.json with your LLM configuration.\n');
  }

  if (missingConfigs.includes('mcp.json')) {
    console.log('\nNote: mcp.json not found. MCP servers will not be loaded.');
    console.log('This is optional - create mcp.json if you need MCP server integration.\n');
  }
}

export async function startCommand(_args: string[]): Promise<void> {
  // In SEA mode, tee stdout/stderr to a log file for the "View Logs" tray action
  if (isSea()) {
    const orchaDir = path.join(require('os').homedir(), '.orcha');
    fsSync.mkdirSync(orchaDir, { recursive: true });
    const logStream = fsSync.createWriteStream(path.join(orchaDir, 'server.log'), { flags: 'w' });
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = (chunk: any, ...args: any[]) => {
      logStream.write(chunk);
      try { return origStdoutWrite(chunk, ...args); } catch { return true; }
    };
    process.stderr.write = (chunk: any, ...args: any[]) => {
      logStream.write(chunk);
      try { return origStderrWrite(chunk, ...args); } catch { return true; }
    };
  }

  // In SEA mode, scaffold workspace on first run
  if (isSea() && !fsSync.existsSync(path.join(workspaceRoot, 'agents'))) {
    console.log(`\nCreating workspace at ${workspaceRoot}...`);
    fsSync.mkdirSync(workspaceRoot, { recursive: true });
    extractTemplates(workspaceRoot);
    console.log('Workspace created with example configuration.\n');
  }

  console.log(`
                ⠀⠀⠀⠀⠀⠀⢀⣀⣀⣀⣀⣀⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
                ⠀⠀⠀⠀⠀⠺⢿⣿⣿⣿⣿⣿⣿⣷⣦⣠⣤⣤⣤⣄⣀⣀⠀⠀⠀⠀⠀⠀⠀⠀
                ⠀⠀⠀⠀⠀⠀⠀⠙⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⣦⣄⠀⠀⠀⠀
                ⠀⠀⠀⠀⠀⠀⢀⣴⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠿⠿⠿⣿⣿⣷⣄⠀⠀
                ⠀⠀⠀⠀⠀⢠⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣀⠀⠀⠀⣀⣿⣿⣿⣆⠀
                ⠀⠀⠀⠀⢠⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡄
                ⠀⠀⠀⠀⣾⣿⣿⡿⠋⠁⣀⣠⣬⣽⣿⣿⣿⣿⣿⣿⠿⠿⠿⠿⠿⠿⠿⠿⠟⠁
                ⠀⠀⠀⢀⣿⣿⡏⢀⣴⣿⠿⠛⠉⠉⠀⢸⣿⣿⠿⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
                ⠀⠀⠀⢸⣿⣿⢠⣾⡟⠁⠀⠀⠀⠀⠀⠈⠉⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
                ⠀⠀⠀⢸⣿⣿⣾⠏⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
                ⠀⠀⠀⣸⣿⣿⣿⣀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
                ⠀⢠⣾⣿⣿⣿⣿⣿⣷⣄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
                ⠀⣾⣿⣿⣿⣿⣿⣿⣿⣿⣦⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
                ⢰⣿⡿⠛⠉⠀⠀⠀⠈⠙⠛⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
                ⠈⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀

  ╔═══════════════════════════════════════════════════════════╗
  ║                      AGENT ORCHA                          ║
  ║       Declare the system. Orcha handles the REST.         ║
  ║               Knowledge, Agent, Action                    ║
  ╚═══════════════════════════════════════════════════════════╝
`);
  console.log(`Workspace root: ${workspaceRoot}\n`);

  // Validate project structure
  try {
    await validateWorkspaceStructure(workspaceRoot);
  } catch (error) {
    process.exit(1);
  }

  const port = parseInt(process.env['PORT'] ?? '3000', 10);
  const host = process.env['HOST'] ?? (isSea() ? '127.0.0.1' : '0.0.0.0');

  logger.info('Initializing Agent Orcha...');

  const orchestrator = new Orchestrator({
    workspaceRoot,
  });

  await orchestrator.initialize();

  logger.info(`Loaded ${orchestrator.agents.names().length} agents`);
  logger.info(`Loaded ${orchestrator.workflows.names().length} workflows`);
  logger.info(`Loaded ${orchestrator.knowledge.listConfigs().length} knowledge configs`);

  const server = await createServer(orchestrator);

  let tray: SystemTray | null = null;
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      logger.info('\nForce exit');
      process.exit(1);
    }
    shuttingDown = true;
    logger.info('\nShutting down...');
    tray?.kill();
    await server.close();
    await orchestrator.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await server.listen({ port, host });
    const url = `http://localhost:${port}`;
    logger.info(`\nServer running at ${url}`);

    if (isSea()) {
      tray = createSystemTray(url, shutdown);
      if (!tray) {
        logger.info(`Open ${url} in your browser`);
      }
    } else {
      logger.info(`Open ${url} in your browser`);
    }
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}
