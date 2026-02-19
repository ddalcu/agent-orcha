import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve base directory first, then load .env from it
const baseDir = process.env.WORKSPACE
  ? path.resolve(process.env.WORKSPACE)
  : path.resolve(__dirname, '..');

const envPath = path.join(baseDir, '.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

import { Orchestrator } from '../lib/index.ts';
import { createServer } from './server.ts';
import { logger } from '../lib/logger.ts';

function resolveResource(name: string): string {
  const resourcePath = path.join(baseDir, name);
  return resourcePath;
}

function validateConfiguration(): void {
  const criticalFiles = [
    { path: resolveResource('llm.json'), name: 'LLM configuration' },
    { path: resolveResource('mcp.json'), name: 'MCP configuration' },
  ];

  const criticalDirs = [
    { path: resolveResource('agents'), name: 'agents directory' },
    { path: resolveResource('workflows'), name: 'workflows directory' },
    { path: resolveResource('knowledge'), name: 'knowledge directory' },
    { path: resolveResource('functions'), name: 'functions directory' },
  ];

  const missingFiles: string[] = [];

  // Check critical files
  for (const { path, name } of criticalFiles) {
    if (!fs.existsSync(path)) {
      missingFiles.push(`${name} (${path})`);
      logger.error(`Missing required file: ${path}`);
    }
  }

  // Check critical directories
  for (const { path, name } of criticalDirs) {
    if (!fs.existsSync(path)) {
      missingFiles.push(`${name} (${path})`);
      logger.error(`Missing required directory: ${path}`);
    }
  }

  if (missingFiles.length > 0) {
    const errorMsg = `Configuration validation failed. Missing ${missingFiles.length} required resource(s):\n` +
      missingFiles.map(f => `  - ${f}`).join('\n') +
      `\n\nBase directory: ${baseDir}\n` +
      `Set WORKSPACE environment variable to specify a different configuration directory.`;

    logger.error(errorMsg);
    throw new Error(errorMsg);
  }

  logger.info('Configuration validation passed');
}

async function main(): Promise<void> {
  const port = parseInt(process.env['PORT'] ?? '3000', 10);
  const host = process.env['HOST'] ?? '0.0.0.0';

  logger.info('Initializing Agent Orchestrator...');
  logger.info(`Base directory: ${baseDir}`);

  // Validate configuration exists before proceeding
  validateConfiguration();

  const orchestrator = new Orchestrator({
    projectRoot: baseDir,
    agentsDir: resolveResource('agents'),
    workflowsDir: resolveResource('workflows'),
    knowledgeDir: resolveResource('knowledge'),
    functionsDir: resolveResource('functions'),
    mcpConfigPath: resolveResource('mcp.json'),
    llmConfigPath: resolveResource('llm.json'),
  });

  await orchestrator.initialize();

  logger.info(`Loaded ${orchestrator.agents.names().length} agents`);
  logger.info(`Loaded ${orchestrator.workflows.names().length} workflows`);
  logger.info(`Loaded ${orchestrator.knowledge.listConfigs().length} knowledge configs`);

  const server = await createServer(orchestrator);

  const triggerManager = orchestrator.triggers.getManager();
  if (triggerManager) {
    const total = triggerManager.cronCount + triggerManager.webhookCount;
    if (total > 0) {
      logger.info(`Loaded ${triggerManager.cronCount} cron trigger(s), ${triggerManager.webhookCount} webhook trigger(s)`);
    }
  }

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

main().catch((error) => {
  logger.error('Fatal error:', error);
  process.exit(1);
});
