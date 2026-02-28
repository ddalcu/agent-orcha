#!/usr/bin/env node

const args = process.argv.slice(2);
const command = args[0];

function showHelp(): void {
  console.log(`
Agent Orcha CLI

Usage:
  npx agent-orcha <command> [options]

Commands:
  init              Initialize a new Agent Orcha project
  start             Start the Agent Orcha server
  help, --help, -h  Show this help message

Examples:
  npx agent-orcha init
  npx agent-orcha start
  npx agent-orcha --help

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
      case 'init': {
        const { initCommand } = await import('./commands/init.ts');
        await initCommand(args.slice(1));
        break;
      }
      case 'start': {
        const { startCommand } = await import('./commands/start.ts');
        await startCommand(args.slice(1));
        break;
      }
      case 'help':
      case '--help':
      case '-h':
      case undefined:
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
