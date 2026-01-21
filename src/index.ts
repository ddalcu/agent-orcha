import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { Orchestrator } from '../lib/index.js';
import { createServer } from './server.js';
import { logger } from '../lib/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

function resolveResource(name: string): string {
  const rootPath = path.join(projectRoot, name);
  const templatePath = path.join(projectRoot, 'templates', name);

  if (fs.existsSync(rootPath)) {
    return rootPath;
  }
  if (fs.existsSync(templatePath)) {
    logger.info(`Using template resource for ${name}`);
    return templatePath;
  }
  return rootPath;
}

async function main(): Promise<void> {
  const port = parseInt(process.env['PORT'] ?? '3000', 10);
  const host = process.env['HOST'] ?? '0.0.0.0';

  logger.info('Initializing Agent Orchestrator...');

  const orchestrator = new Orchestrator({
    projectRoot,
    agentsDir: resolveResource('agents'),
    workflowsDir: resolveResource('workflows'),
    vectorsDir: resolveResource('vectors'),
    functionsDir: resolveResource('functions'),
    mcpConfigPath: resolveResource('mcp.json'),
    llmConfigPath: resolveResource('llm.json'),
  });

  await orchestrator.initialize();

  logger.info(`Loaded ${orchestrator.agents.names().length} agents`);
  logger.info(`Loaded ${orchestrator.workflows.names().length} workflows`);
  logger.info(`Loaded ${orchestrator.vectors.listConfigs().length} vector configs`);

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

main().catch((error) => {
  logger.error('Fatal error:', error);
  process.exit(1);
});
