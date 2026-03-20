#!/usr/bin/env node

import { seaBootstrap } from '../../lib/sea/bootstrap.ts';
seaBootstrap();

const args = process.argv.slice(2);
const command = args[0];

function showHelp(): void {
  console.log(`
Agent Orcha CLI

Usage:
  npx agent-orcha [start] [options]

Commands:
  start             Start the Agent Orcha server (default)
  help, --help, -h  Show this help message

Environment:
  WORKSPACE         Path to workspace directory (default: ~/.orcha/workspace)

Examples:
  npx agent-orcha
  npx agent-orcha start
  WORKSPACE=./my-project npx agent-orcha

Library Usage:
  import { Orchestrator } from 'agent-orcha';

  const orchestrator = new Orchestrator({ workspaceRoot: '.' });
  await orchestrator.initialize();

Documentation: https://github.com/ddalcu/agent-orcha
`);
}

async function main(): Promise<void> {
  try {
    switch (command) {
      case 'start':
      case undefined: {
        const { startCommand } = await import('./commands/start.ts');
        await startCommand(args.slice(1));
        break;
      }
      case 'help':
      case '--help':
      case '-h':
        showHelp();
        break;
      default:
        console.error(`Unknown command: ${command}`);
        console.error('Run "npx agent-orcha --help" for usage information.');
        process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
