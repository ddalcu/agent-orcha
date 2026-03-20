import { spawn, execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { isSea, getOrchaDir } from './bootstrap.ts';
import { logger } from '../logger.ts';

const ORCHA_DIR = getOrchaDir();

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

  if (process.platform === 'win32') {
    const name = 'tray_windows_release.exe';
    if (isSea()) {
      return path.join(ORCHA_DIR, 'native', name);
    }
    return path.join('node_modules', 'systray2', 'traybin', name);
  }

  // Linux: console-only, no system tray
  throw new Error(`Unsupported platform: ${process.platform}`);
}

function loadIconAsBase64(): string {
  if (isSea()) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sea = require('node:sea');
    const buf = sea.getRawAsset('tray-icon');
    return Buffer.from(buf).toString('base64');
  }
  return fs.readFileSync('scripts/favicon.png').toString('base64');
}

// Win32 console visibility toggle — uses PowerShell to call ShowWindow via P/Invoke.
// SW_HIDE = 0, SW_SHOW = 5
let consoleVisible = true;
const WIN32_SHOWWINDOW_PS = 'Add-Type -Name W -Namespace N -MemberDefinition \'[DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int c);\';';

function setConsoleVisible(show: boolean): void {
  if (process.platform !== 'win32') return;
  try {
    const sw = show ? 5 : 0;
    const child = execFile('powershell', ['-NoProfile', '-Command',
      `${WIN32_SHOWWINDOW_PS}[N.W]::ShowWindow((Get-Process -Id ${process.pid}).MainWindowHandle,${sw})`],
      { windowsHide: true });
    child.unref();
    consoleVisible = show;
  } catch { /* best effort */ }
}

export function hideConsoleWindow(): void {
  setConsoleVisible(false);
}

export function toggleConsoleWindow(): void {
  setConsoleVisible(!consoleVisible);
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
      { title: process.platform === 'win32' ? 'Toggle Console' : 'Show Console', tooltip: 'Show server logs', enabled: true, __id: CONSOLE_ID },
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
    const child = execFile('open', ['-a', 'Console', logFile], { windowsHide: true });
    child.unref();
  } else if (process.platform === 'win32') {
    toggleConsoleWindow();
  }
}
