import dotenv from 'dotenv';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { isSea, getOrchaDir, resolveWorkspace, scaffoldWorkspace } from '../../../lib/sea/bootstrap.ts';
import { TrayConsole } from '@agent-orcha/trayconsolejs';
import { openAppWindow } from '../../../lib/sea/app-window.ts';

const workspaceRoot = resolveWorkspace();

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
    console.error('Remove WORKSPACE env var to use the default workspace (~/.orcha/workspace).\n');
    throw new Error('Invalid workspace structure');
  }

  // Check for config files
  const configFiles = ['models.yaml', 'mcp.json'];
  const missingConfigs = [];

  for (const file of configFiles) {
    const filePath = path.join(workspaceRoot, file);
    try {
      await fs.access(filePath);
    } catch {
      missingConfigs.push(file);
    }
  }

  if (missingConfigs.includes('models.yaml')) {
    console.error('\nWarning: models.yaml not found. Model functionality may not work correctly.');
    console.error('Create models.yaml with your model configuration.\n');
  }

  if (missingConfigs.includes('mcp.json')) {
    console.log('\nNote: mcp.json not found. MCP servers will not be loaded.');
    console.log('This is optional - create mcp.json if you need MCP server integration.\n');
  }
}

/**
 * Resolve icon paths for the tray. In SEA mode icons are extracted to ~/.orcha/,
 * otherwise they're in the repo's scripts/ directory.
 */
function resolveIcons(): { ico: string; png: string } {
  if (isSea()) {
    const orchaDir = getOrchaDir();
    return {
      ico: path.join(orchaDir, 'native', 'tray-icon'),
      png: path.join(orchaDir, 'native', 'tray-icon'),
    };
  }
  return {
    ico: path.join('scripts', 'AppIcon.ico'),
    png: path.join('scripts', 'favicon.png'),
  };
}

export async function startCommand(_args: string[]): Promise<void> {
  // In SEA mode, set up TrayConsole (log window + system tray) and pipe output to it
  let trayConsole: TrayConsole | null = null;

  // Hoisted so the tray onClicked handler can reference it before server init completes.
  // Falls back to a simple quit if called before the server is set up.
  let shutdown = (): void => {
    trayConsole?.quit();
    process.exit(0);
  };

  if (isSea()) {
    const orchaDir = getOrchaDir();
    fsSync.mkdirSync(orchaDir, { recursive: true });
    const logStream = fsSync.createWriteStream(path.join(orchaDir, 'server.log'), { flags: 'w' });

    // Point TrayConsole to the extracted binary in SEA mode
    const tcBinName = process.platform === 'win32' ? 'trayconsole.exe' : 'trayconsole';
    process.env.TRAYCONSOLE_BIN = path.join(orchaDir, 'native', tcBinName);

    // Create tray console — it shows immediately with a log window
    trayConsole = new TrayConsole({
      icon: resolveIcons(),
      tooltip: 'Agent Orcha',
      title: 'Agent Orcha — Starting...',
      onClicked: (id) => {
        if (id === 'open') openAppWindow(`http://localhost:${process.env['PORT'] ?? '3333'}`);
        else if (id === 'show') trayConsole!.showWindow();
        else if (id === 'quit') shutdown();
      },
      onMenuRequested: () => [
        { id: 'open', title: 'Open in Browser' },
        { id: 'show', title: 'Show Console' },
        { id: 'sep', separator: true },
        { id: 'quit', title: 'Quit' },
      ],
    });

    // Tee stdout/stderr to log file + tray console window
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = (chunk: any, ...args: any[]) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString();
      logStream.write(chunk);
      trayConsole?.appendLog(text);
      try { return origStdoutWrite(chunk, ...args); } catch { return true; }
    };
    process.stderr.write = (chunk: any, ...args: any[]) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString();
      logStream.write(chunk);
      trayConsole?.appendLog(text);
      try { return origStderrWrite(chunk, ...args); } catch { return true; }
    };

    // Keep the tray console visible on fatal errors so the user can read what went wrong.
    const handleFatalError = (label: string, err: unknown) => {
      const msg = err instanceof Error ? err.stack ?? err.message : String(err);
      const lines = [
        '',
        `*** ${label} ***`,
        msg,
        '',
        'The application failed to start. The console will stay open so you can read the error above.',
        'Right-click the tray icon and choose Quit to exit.',
      ];
      for (const line of lines) {
        logStream.write(line + '\n');
        trayConsole?.appendLog(line + '\n');
      }
      trayConsole?.setTitle('Agent Orcha — ERROR');
      trayConsole?.showWindow();
    };

    process.on('uncaughtException', (err) => {
      handleFatalError('Uncaught Exception', err);
      // Do NOT exit — keep the tray console alive
    });
    process.on('unhandledRejection', (err) => {
      handleFatalError('Unhandled Rejection', err);
    });
  }

  // Scaffold workspace on first run (works for both SEA and non-SEA)
  scaffoldWorkspace(workspaceRoot);

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
    if (!trayConsole) process.exit(1);
    return; // uncaughtException handler keeps the tray alive
  }

  const port = parseInt(process.env['PORT'] ?? '3333', 10);
  const host = process.env['HOST'] ?? (isSea() ? '127.0.0.1' : '0.0.0.0');

  logger.info('Initializing Agent Orcha...');

  let orchestrator: Orchestrator | undefined;
  let server: Awaited<ReturnType<typeof createServer>> | undefined;

  try {
    orchestrator = new Orchestrator({
      workspaceRoot,
    });

    await orchestrator.initialize();

    logger.info(`Loaded ${orchestrator.agents.names().length} agents`);
    logger.info(`Loaded ${orchestrator.workflows.names().length} workflows`);
    logger.info(`Loaded ${orchestrator.knowledge.listConfigs().length} knowledge configs`);

    server = await createServer(orchestrator);
  } catch (error) {
    logger.error('Failed to initialize:', error);
    if (!trayConsole) process.exit(1);
    return; // uncaughtException/tray keeps process alive
  }

  let shuttingDown = false;
  shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      logger.info('\nForce exit');
      process.exit(1);
    }
    shuttingDown = true;
    logger.info('\nShutting down...');
    // Close tray immediately — don't make the user wait for async cleanup
    trayConsole?.quit();
    trayConsole = null;
    // Force exit after 5s if async cleanup hangs
    setTimeout(() => process.exit(0), 5000).unref();
    await server!.close();
    await orchestrator!.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await server.listen({ port, host });
    const url = `http://localhost:${port}`;
    logger.info(`\nServer running at ${url}`);

    if (trayConsole) {
      trayConsole.setTitle(`Agent Orcha — ${url}`);
      trayConsole.setTooltip(`Agent Orcha — ${url}`);
      openAppWindow(url);
    } else {
      logger.info(`Open ${url} in your browser`);
    }
  } catch (error) {
    logger.error('Failed to start server:', error);
    if (!trayConsole) process.exit(1);
  }
}
