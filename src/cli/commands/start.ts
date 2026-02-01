import dotenv from 'dotenv';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';

// Load .env from the project root (cwd), which is the CLI convention
const cliEnvPath = path.join(process.cwd(), '.env');
if (fsSync.existsSync(cliEnvPath)) {
  dotenv.config({ path: cliEnvPath });
} else {
  dotenv.config();
}

import { Orchestrator } from '../../../lib/index.js';
import { createServer } from '../../server.js';
import { logger } from '../../../lib/logger.js';

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(dirPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

async function validateProjectStructure(projectRoot: string): Promise<void> {
  const requiredDirs = ['agents', 'functions', 'knowledge', 'workflows'];
  const missingDirs = [];

  for (const dir of requiredDirs) {
    const dirPath = path.join(projectRoot, dir);
    if (!(await directoryExists(dirPath))) {
      missingDirs.push(dir);
    }
  }

  if (missingDirs.length > 0) {
    console.error('\nError: Required directories not found in current directory:');
    missingDirs.forEach(dir => console.error(`  - ${dir}/`));
    console.error('\nThis does not appear to be an Agent Orcha project.');
    console.error('Run "npx agent-orcha init" to create a new project.\n');
    throw new Error('Invalid project structure');
  }

  // Check for config files
  const configFiles = ['llm.json', 'mcp.json'];
  const missingConfigs = [];

  for (const file of configFiles) {
    const filePath = path.join(projectRoot, file);
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
  const projectRoot = process.cwd();

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
  console.log(`Project root: ${projectRoot}\n`);

  // Validate project structure
  try {
    await validateProjectStructure(projectRoot);
  } catch (error) {
    process.exit(1);
  }

  const port = parseInt(process.env['PORT'] ?? '3000', 10);
  const host = process.env['HOST'] ?? '0.0.0.0';

  logger.info('Initializing Agent Orcha...');

  const orchestrator = new Orchestrator({
    projectRoot,
  });

  await orchestrator.initialize();

  logger.info(`Loaded ${orchestrator.agents.names().length} agents`);
  logger.info(`Loaded ${orchestrator.workflows.names().length} workflows`);
  logger.info(`Loaded ${orchestrator.knowledge.listConfigs().length} knowledge configs`);

  const server = await createServer(orchestrator);

  const shutdown = async (): Promise<void> => {
    logger.info('\nShutting down...');
    await server.close();
    await orchestrator.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await server.listen({ port, host });
    logger.info(`\nServer running at http://localhost:${port}`);
    logger.info(`Open http://localhost:${port} in your browser`);
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}
