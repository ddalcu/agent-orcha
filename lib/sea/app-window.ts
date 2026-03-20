import { execFile } from 'child_process';
import { existsSync } from 'fs';

interface BrowserCandidate {
  cmd: string;
  args: (url: string) => string[];
  appPath?: string; // macOS: check this path exists instead of cmd
}

// macOS: use `open -a` to launch via Launch Services (avoids Automation permission dialogs)
const MACOS_BROWSERS: BrowserCandidate[] = [
  {
    cmd: 'open',
    args: (url) => ['-a', 'Google Chrome', url, '--args', `--app=${url}`],
    appPath: '/Applications/Google Chrome.app',
  },
  {
    cmd: 'open',
    args: (url) => ['-a', 'Microsoft Edge', url, '--args', `--app=${url}`],
    appPath: '/Applications/Microsoft Edge.app',
  },
  {
    cmd: 'open',
    args: (url) => ['-a', 'Chromium', url, '--args', `--app=${url}`],
    appPath: '/Applications/Chromium.app',
  },
  {
    cmd: 'open',
    args: (url) => ['-a', 'Brave Browser', url, '--args', `--app=${url}`],
    appPath: '/Applications/Brave Browser.app',
  },
];

const LINUX_BROWSERS: BrowserCandidate[] = [
  { cmd: 'google-chrome', args: (url) => [`--app=${url}`] },
  { cmd: 'google-chrome-stable', args: (url) => [`--app=${url}`] },
  { cmd: 'chromium-browser', args: (url) => [`--app=${url}`] },
  { cmd: 'chromium', args: (url) => [`--app=${url}`] },
  { cmd: 'microsoft-edge', args: (url) => [`--app=${url}`] },
  { cmd: 'brave-browser', args: (url) => [`--app=${url}`] },
];

const WINDOWS_BROWSERS: BrowserCandidate[] = [
  {
    cmd: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: (url) => [`--app=${url}`, '--new-window'],
  },
  {
    cmd: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    args: (url) => [`--app=${url}`, '--new-window'],
  },
  {
    cmd: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    args: (url) => [`--app=${url}`, '--new-window'],
  },
  {
    cmd: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    args: (url) => [`--app=${url}`, '--new-window'],
  },
  {
    cmd: 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    args: (url) => [`--app=${url}`, '--new-window'],
  },
];

function getCandidates(): BrowserCandidate[] {
  switch (process.platform) {
    case 'darwin': return MACOS_BROWSERS;
    case 'linux': return LINUX_BROWSERS;
    case 'win32': return WINDOWS_BROWSERS;
    default: return [];
  }
}

function findBrowser(): BrowserCandidate | null {
  for (const candidate of getCandidates()) {
    const checkPath = candidate.appPath || candidate.cmd;
    if (checkPath.includes('/') || checkPath.includes('\\')) {
      if (existsSync(checkPath)) return candidate;
    } else {
      return candidate;
    }
  }
  return null;
}

/**
 * Open the URL in a chromeless app-mode browser window.
 * Falls back to the OS default browser if no Chromium-based browser is found.
 * Spawns detached — the child process lives independently of the server.
 */
export function openAppWindow(url: string): void {
  const browser = findBrowser();

  if (browser) {
    const child = execFile(browser.cmd, browser.args(url), { windowsHide: true });
    child.unref();
    return;
  }

  // Fallback: open in default browser (will have URL bar, but better than nothing)
  const fallback: Record<string, { cmd: string; args: string[] }> = {
    darwin: { cmd: 'open', args: [url] },
    linux: { cmd: 'xdg-open', args: [url] },
    win32: { cmd: 'cmd', args: ['/c', 'start', url] },
  };

  const fb = fallback[process.platform];
  if (fb) {
    const child = execFile(fb.cmd, fb.args, { windowsHide: true });
    child.unref();
  }
}
