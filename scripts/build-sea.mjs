#!/usr/bin/env node

// Build script for creating a Single Executable Application (SEA).
// Requires Node.js 25.5+ for the --build-sea flag.
// Usage: node scripts/build-sea.mjs

import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

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
  },
};

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
  // Mark platform-specific sqlite-vec packages as external (not needed in SEA)
  external: [
    'sqlite-vec-*',
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
  // sqlite-vec uses Node.js platform/arch names: darwin-arm64, linux-x64, win32-x64
  const pkgName = `sqlite-vec-${platform}-${arch}`;
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

// --- 5. Sign on macOS ---

if (platform === 'darwin') {
  console.log('Signing binary...');
  execFileSync('codesign', ['--sign', '-', outputPath]);
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
