#!/usr/bin/env node

// Build script for creating a Single Executable Application (SEA).
// Requires Node.js 25.5+ for the --build-sea flag.
// Usage: node scripts/build-sea.mjs

import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, execSync } from 'child_process';

const nodeVersion = parseInt(process.versions.node.split('.')[0]);
if (nodeVersion < 25) {
  console.error(`Node.js 25+ required for --build-sea (current: ${process.versions.node})`);
  console.error('Install Node 25 via: nvm install 25 && nvm use 25');
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const platform = process.platform;
const arch = process.arch;

// --- 1. Bundle with esbuild ---

// Plugin: inline files that libraries read via readFileSync + __dirname at load time.
// These break in a bundled binary because the relative directory structure is lost.
const inlineStaticReadsPlugin = {
  name: 'inline-static-reads',
  setup(build) {
    // jsdom reads its default stylesheet CSS at module load time
    build.onLoad({ filter: /jsdom.*style-rules\.js$/ }, async (args) => {
      let contents = await fs.promises.readFile(args.path, 'utf8');
      const cssPath = path.resolve(path.dirname(args.path), '../../browser/default-stylesheet.css');
      const cssContent = await fs.promises.readFile(cssPath, 'utf8');
      contents = contents.replace(
        /fs\.readFileSync\(\s*path\.resolve\(__dirname[\s\S]*?\{[^}]*\}\s*\)/,
        JSON.stringify(cssContent),
      );
      return { contents, loader: 'js' };
    });

    // jsdom uses require.resolve for sync XHR worker — not available in SEA
    build.onLoad({ filter: /XMLHttpRequest-impl\.js$/ }, async (args) => {
      let contents = await fs.promises.readFile(args.path, 'utf8');
      // Replace require.resolve with __filename (sync XHR won't work, but it's unused)
      contents = contents.replace(
        /const syncWorkerFile = require\.resolve\([^)]+\);/,
        'const syncWorkerFile = "";',
      );
      return { contents, loader: 'js' };
    });

    // Hyperswarm native addons (sodium-native, udx-native) use require-addon to load
    // .node prebuilts, which breaks in SEA because __filename resolves to the binary path.
    // Replace their binding.js with a shim that loads from the extracted ~/.orcha/native/ path
    // using process.dlopen (esbuild's require can't load .node files directly).
    build.onLoad({ filter: /(sodium-native|udx-native)[\\/]binding\.js$/ }, async (args) => {
      const addonName = path.basename(path.dirname(args.path));
      return {
        contents: `
          const { getNativeAddonPath, isSea } = require('./lib/sea/bootstrap.ts');
          if (isSea()) {
            const mod = { exports: {} };
            process.dlopen(mod, getNativeAddonPath('${addonName}'));
            module.exports = mod.exports;
          } else {
            require.addon = require('require-addon');
            module.exports = require.addon('.', __filename);
          }
        `,
        loader: 'js',
        resolveDir: path.resolve('.'),
      };
    });

    // node-omni-orcha binding loader — replace with SEA-aware dlopen shim.
    // The original uses createRequire(import.meta.url) which breaks in CJS SEA bundles.
    build.onLoad({ filter: /node-omni-orcha[\\/](?:src|dist)[\\/]binding-loader\.[tj]s$/ }, async (args) => {
      return {
        contents: `
          import { getNativeAddonPath, isSea } from './lib/sea/bootstrap.ts';
          import { availableParallelism } from 'os';

          // Preserve UV_THREADPOOL_SIZE side effect from original binding-loader
          if (!process.env['UV_THREADPOOL_SIZE']) {
            process.env['UV_THREADPOOL_SIZE'] = String(Math.max(availableParallelism(), 8));
          }

          let cachedBinding = null;

          export function loadBinding() {
            if (cachedBinding) return cachedBinding;

            if (isSea()) {
              const mod = { exports: {} };
              process.dlopen(mod, getNativeAddonPath('omni'));
              cachedBinding = mod.exports;
              return cachedBinding;
            }

            // Non-SEA fallback (dev mode)
            const { createRequire } = require('module');
            const req = createRequire(__filename);
            const p = process.platform, a = process.arch;
            for (const c of [p + '-' + a + '-cuda', p + '-' + a]) {
              try {
                cachedBinding = req('@agent-orcha/node-omni-orcha-' + c + '/omni.node');
                return cachedBinding;
              } catch {}
            }
            throw new Error('omni.node native binding not found');
          }
        `,
        loader: 'js',
        resolveDir: path.resolve('.'),
      };
    });
  },
};

// --- 0. Build Svelte UI (public/ is gitignored, must be built fresh) ---

if (!fs.existsSync('public/index.html')) {
  console.log('Building Svelte UI...');
  execSync('npm ci', { cwd: 'ui', stdio: 'inherit' });
  execSync('npm run build', { cwd: 'ui', stdio: 'inherit' });
}

console.log('Bundling application...');

await esbuild.build({
  entryPoints: ['src/cli/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node25',
  outfile: 'dist/sea/app.js',
  alias: {
    'sqlite-vec': './lib/sea/sqlite-vec-shim.ts',
  },
  plugins: [inlineStaticReadsPlugin],
  external: [
    'sqlite-vec-*',
    'vite',          // Dev-only (vite-dev-integration.ts, guarded by NODE_ENV check)
    'lightningcss',  // Vite dependency, not needed at runtime
    'fsevents',      // macOS-only native module from Vite's dep tree
  ],
  // Provide import.meta.url in CJS output — some code uses it for __dirname
  define: {
    'import.meta.url': '__seaImportMetaUrl',
  },
  banner: {
    js: 'var __seaImportMetaUrl = require("url").pathToFileURL(__filename).href;\n',
  },
  logLevel: 'warning',
});

console.log('Bundle complete: dist/sea/app.js');

// --- 2. Enumerate assets ---

const assets = {};

// Version marker
fs.mkdirSync('dist/sea', { recursive: true });
fs.writeFileSync('dist/sea/version.txt', pkg.version);
assets['version'] = 'dist/sea/version.txt';

// Recursively add all files from a directory
function addDirectory(baseDir, prefix, excludes = []) {
  if (!fs.existsSync(baseDir)) return;

  const entries = fs.readdirSync(baseDir, { withFileTypes: true });
  for (const entry of entries) {
    if (excludes.includes(entry.name)) continue;
    if (entry.name === '.DS_Store') continue;

    const fullPath = path.join(baseDir, entry.name);

    if (entry.isDirectory()) {
      addDirectory(fullPath, `${prefix}/${entry.name}`, excludes);
    } else if (entry.isFile()) {
      assets[`${prefix}/${entry.name}`] = fullPath;
    }
  }
}

// Public directory (web UI)
addDirectory('public', 'public');

// Templates (exclude heavy runtime data)
addDirectory('templates', 'templates', [
  '.llama-server',
  '.models',
  '.knowledge-data',
  '.knowledge-cache',
]);

// sqlite-vec native extension
function findSqliteVecLib() {
  // sqlite-vec packages use 'windows' not 'win32': sqlite-vec-windows-x64, sqlite-vec-darwin-arm64, etc.
  const vecPlatform = platform === 'win32' ? 'windows' : platform;
  const pkgName = `sqlite-vec-${vecPlatform}-${arch}`;
  const ext = platform === 'win32' ? 'dll' : platform === 'darwin' ? 'dylib' : 'so';
  const libPath = path.join('node_modules', pkgName, `vec0.${ext}`);

  if (!fs.existsSync(libPath)) {
    console.error(`sqlite-vec native lib not found: ${libPath}`);
    console.error(`Install it: npm install ${pkgName}`);
    process.exit(1);
  }

  return { libPath, ext };
}

const vec = findSqliteVecLib();
assets[`native/vec0.${vec.ext}`] = vec.libPath;

// Hyperswarm native addon prebuilts (required for P2P)
for (const addon of ['sodium-native', 'udx-native']) {
  const prebuilt = path.join('node_modules', addon, 'prebuilds', `${platform}-${arch}`, `${addon}.node`);
  if (fs.existsSync(prebuilt)) {
    assets[`native/${addon}.node`] = prebuilt;
  } else {
    console.warn(`${addon} prebuilt not found: ${prebuilt} — P2P may not work in SEA binary`);
  }
}

// node-omni-orcha native addon (local LLM/TTS/STT/Image inference)
{
  const omniCandidates = [
    `@agent-orcha/node-omni-orcha-${platform}-${arch}-cuda`,
    `@agent-orcha/node-omni-orcha-${platform}-${arch}`,
  ];

  let omniFound = false;
  for (const pkg of omniCandidates) {
    const nodePath = path.join('node_modules', pkg, 'omni.node');
    if (fs.existsSync(nodePath)) {
      assets['native/omni.node'] = nodePath;
      console.log(`Embedding omni.node from: ${pkg}`);
      // Also embed .metallib if present (macOS pre-compiled Metal shaders)
      const metallibPath = path.join('node_modules', pkg, 'default.metallib');
      if (fs.existsSync(metallibPath)) {
        assets['native/default.metallib'] = metallibPath;
      }
      omniFound = true;
      break;
    }
  }
  if (!omniFound) {
    console.warn('omni.node not found — local LLM/TTS/STT/Image will not work in SEA binary');
  }
}

// System tray binary (macOS + Windows only; Linux is console-only)
if (platform === 'darwin') {
  const trayHelperPath = path.join('scripts', 'tray-helper');
  if (fs.existsSync(trayHelperPath)) {
    assets['native/tray-helper'] = trayHelperPath;
  } else {
    console.warn('tray-helper not found — run: swiftc -O -o scripts/tray-helper scripts/tray-helper.swift');
  }
} else if (platform === 'win32') {
  const trayBinName = 'tray_windows_release.exe';
  const trayBinPath = path.join('node_modules', 'systray2', 'traybin', trayBinName);
  if (fs.existsSync(trayBinPath)) {
    assets[`native/${trayBinName}`] = trayBinPath;
  } else {
    console.warn(`systray2 binary not found: ${trayBinPath} — system tray won't work`);
  }
}

// Tray icon
const trayIconPath = platform === 'win32' ? 'scripts/AppIcon.ico' : 'scripts/favicon.png';
if (fs.existsSync(trayIconPath)) {
  assets['tray-icon'] = trayIconPath;
}

console.log(`Embedding ${Object.keys(assets).length} assets`);

// --- 3. Generate sea-config.json ---

const exeName = platform === 'win32' ? 'agent-orcha.exe' : 'agent-orcha';
const outputPath = `dist/sea/${exeName}`;

const seaConfig = {
  main: 'dist/sea/app.js',
  mainFormat: 'commonjs',
  output: outputPath,
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  useSnapshot: false,
  assets,
};

fs.writeFileSync('dist/sea/sea-config.json', JSON.stringify(seaConfig, null, 2));

// --- 4. Build SEA binary ---

console.log('Building SEA binary...');
execFileSync(process.execPath, ['--build-sea', 'dist/sea/sea-config.json'], {
  stdio: 'inherit',
});

// --- 5. Platform-specific post-processing ---

if (platform === 'darwin') {
  console.log('Signing binary...');
  execFileSync('codesign', ['--sign', '-', outputPath]);
} else if (platform === 'win32') {
  // Stamp icon onto the .exe so it shows in Explorer
  const icoPath = 'scripts/AppIcon.ico';
  try {
    const { rcedit } = await import('rcedit');
    const opts = {};
    if (fs.existsSync(icoPath)) {
      opts.icon = icoPath;
    } else {
      console.warn(`${icoPath} not found — .exe will use default Node icon`);
    }
    await rcedit(outputPath, opts);
    console.log('Patched .exe' + (opts.icon ? ' (icon stamped)' : ''));
  } catch (e) {
    console.warn(`rcedit failed: ${e.message} — install with: npm i -D rcedit`);
  }

  // Patch PE subsystem: Console (3) → GUI (2) so no console window is created on launch.
  const buf = fs.readFileSync(outputPath);
  const peOff = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(peOff) !== 0x00004550) {
    throw new Error('Invalid PE signature in output binary');
  }
  const subsysOff = peOff + 0x5c;
  const current = buf.readUInt16LE(subsysOff);
  if (current === 3) {
    buf.writeUInt16LE(2, subsysOff);
    fs.writeFileSync(outputPath, buf);
    console.log('Patched PE subsystem: Console → GUI');
  } else {
    console.warn(`PE subsystem is ${current}, expected 3 (Console) — skipping patch`);
  }
}

// --- 6. Report ---

const stats = fs.statSync(outputPath);
const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
const target = `${platform}-${arch}`;

console.log(`\nBuild complete!`);
console.log(`  Binary: ${outputPath}`);
console.log(`  Target: ${target}`);
console.log(`  Size:   ${sizeMB} MB`);
console.log(`  Version: ${pkg.version}`);
