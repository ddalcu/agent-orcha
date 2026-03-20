import { spawn, execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { isSea } from './bootstrap.ts';
import { logger } from '../logger.ts';

const ORCHA_DIR = path.join(os.homedir(), '.orcha');

interface TrayMenuItem {
  title: string;
  tooltip?: string;
  enabled?: boolean;
  __id?: number;
}

interface TrayConfig {
  icon: string;
  title: string;
  tooltip: string;
  items: TrayMenuItem[];
}

function getTrayBinPath(): string {
  if (process.platform === 'darwin') {
    // Native Swift tray helper
    if (isSea()) {
      return path.join(ORCHA_DIR, 'native', 'tray-helper');
    }
    return path.join('scripts', 'tray-helper');
  }

  // Linux/Windows: systray2 Go binary
  const binName: Record<string, string> = {
    win32: 'tray_windows_release.exe',
    linux: 'tray_linux_release',
  };
  const name = binName[process.platform];
  if (!name) throw new Error(`Unsupported platform: ${process.platform}`);

  if (isSea()) {
    return path.join(ORCHA_DIR, 'native', name);
  }
  return path.join('node_modules', 'systray2', 'traybin', name);
}

function loadIconAsBase64(): string {
  if (isSea()) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sea = require('node:sea');
    const buf = sea.getRawAsset('tray-icon');
    return Buffer.from(buf).toString('base64');
  }
  return fs.readFileSync('docs/favicon.png').toString('base64');
}

export interface SystemTray {
  kill(): void;
}

/**
 * Create a system tray icon with menu actions.
 * Non-blocking — spawns a subprocess and communicates via JSON over stdio.
 */
export function createSystemTray(url: string, onQuit: () => void): SystemTray | null {
  let binPath: string;
  try {
    binPath = getTrayBinPath();
  } catch {
    return null;
  }

  if (!fs.existsSync(binPath)) {
    logger.warn('[SystemTray] Tray binary not found, skipping system tray');
    return null;
  }

  try {
    fs.chmodSync(binPath, 0o755);
  } catch { /* ignore on Windows */ }

  const proc = spawn(binPath, [], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  proc.stderr!.on('data', (d: Buffer) => {
    const msg = d.toString().trim();
    if (msg) logger.debug(`[SystemTray] ${msg}`);
  });

  const rl = readline.createInterface({ input: proc.stdout! });

  const OPEN_ID = 1;
  const CONSOLE_ID = 2;
  const QUIT_ID = 3;

  const icon = loadIconAsBase64();
  const logFile = path.join(ORCHA_DIR, 'server.log');

  const menu: TrayConfig = {
    icon,
    title: '',
    tooltip: 'Agent Orcha',
    items: [
      { title: `Agent Orcha — ${url}`, enabled: false, __id: 0 },
      { title: 'Open in Browser', tooltip: 'Open the Studio UI', enabled: true, __id: OPEN_ID },
      { title: '<SEPARATOR>', enabled: false, __id: -1 },
      { title: 'Show Console', tooltip: 'Show server logs', enabled: true, __id: CONSOLE_ID },
      { title: 'Quit', tooltip: 'Stop the server', enabled: true, __id: QUIT_ID },
    ],
  };

  rl.on('line', (line: string) => {
    try {
      const action = JSON.parse(line);
      if (action.type === 'ready') {
        proc.stdin!.write(JSON.stringify(menu) + '\n');
        logger.info('[SystemTray] System tray active');
        openInBrowser(url);
      } else if (action.type === 'clicked') {
        if (action.__id === OPEN_ID) {
          openInBrowser(url);
        } else if (action.__id === CONSOLE_ID) {
          openConsole(logFile);
        } else if (action.__id === QUIT_ID) {
          onQuit();
        }
      }
    } catch { /* ignore parse errors */ }
  });

  proc.on('error', (err: Error) => {
    logger.warn(`[SystemTray] Failed to start: ${err.message}`);
  });

  return {
    kill() {
      try {
        proc.stdin!.write(JSON.stringify({ type: 'exit' }) + '\n');
      } catch { /* already dead */ }
    },
  };
}

function openInBrowser(url: string): void {
  const cmds: Record<string, { cmd: string; args: string[] }> = {
    darwin: { cmd: 'open', args: [url] },
    linux: { cmd: 'xdg-open', args: [url] },
    win32: { cmd: 'cmd', args: ['/c', 'start', url] },
  };

  const fb = cmds[process.platform];
  if (fb) {
    const child = execFile(fb.cmd, fb.args, { windowsHide: true });
    child.unref();
  }
}

function openConsole(logFile: string): void {
  if (process.platform === 'darwin') {
    // Use `open` to launch Console.app filtered to the log file (no Automation permission needed)
    const child = execFile('open', ['-a', 'Console', logFile], { windowsHide: true });
    child.unref();
  } else if (process.platform === 'linux') {
    // Try common terminal emulators
    for (const term of ['gnome-terminal', 'xterm', 'konsole']) {
      try {
        const child = execFile(term, ['--', 'tail', '-f', logFile]);
        child.unref();
        return;
      } catch { continue; }
    }
  } else if (process.platform === 'win32') {
    const child = execFile('cmd', ['/c', 'start', 'cmd', '/k', `type "${logFile}" & echo. & echo Watching... & powershell -Command "Get-Content '${logFile}' -Wait -Tail 50"`]);
    child.unref();
  }
}
