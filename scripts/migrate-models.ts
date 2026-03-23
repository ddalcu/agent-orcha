/**
 * One-time migration: move flat model files into group folders.
 *
 * Usage: node scripts/migrate-models.ts
 */
import * as fs from 'fs/promises';
import { copyFileSync, existsSync } from 'fs';
import * as path from 'path';

const MODELS_DIR = '/Users/david/.orcha/workspace/.models';

interface MoveOp {
  file: string;
  targetDir: string;
}

interface CopyOp {
  file: string;
  targetDir: string;
}

const MOVES: MoveOp[] = [
  // FLUX.2 Klein → flux2-klein/
  { file: 'flux-2-klein-4b-Q4_K_M.gguf', targetDir: 'flux2-klein' },
  { file: 'flux-2-klein-4b-Q4_K_M.gguf.meta.json', targetDir: 'flux2-klein' },
  { file: 'Qwen3-4B-Q4_K_M.gguf', targetDir: 'flux2-klein' },
  { file: 'Qwen3-4B-Q4_K_M.gguf.meta.json', targetDir: 'flux2-klein' },
  { file: 'flux2-vae.safetensors', targetDir: 'flux2-klein' },
  { file: 'flux2-vae.safetensors.meta.json', targetDir: 'flux2-klein' },
  { file: 'mmproj-BF16.gguf', targetDir: 'flux2-klein' },
  { file: 'mmproj-BF16.gguf.meta.json', targetDir: 'flux2-klein' },

  // WAN2.2 Turbo A14B → wan22-turbo/
  { file: 'Wan2.2-T2V-A14B-LowNoise-Q4_K_M.gguf', targetDir: 'wan22-turbo' },
  { file: 'Wan2.2-T2V-A14B-LowNoise-Q4_K_M.gguf.meta.json', targetDir: 'wan22-turbo' },
  { file: 'Wan2.2-T2V-A14B-HighNoise-Q4_K_M.gguf', targetDir: 'wan22-turbo' },
  { file: 'Wan2.2-T2V-A14B-HighNoise-Q4_K_M.gguf.meta.json', targetDir: 'wan22-turbo' },
  { file: 'umt5-xxl-encoder-Q8_0.gguf', targetDir: 'wan22-turbo' },
  { file: 'umt5-xxl-encoder-Q8_0.gguf.meta.json', targetDir: 'wan22-turbo' },
  { file: 'Wan2.1_VAE.safetensors', targetDir: 'wan22-turbo' },
  { file: 'Wan2.1_VAE.safetensors.meta.json', targetDir: 'wan22-turbo' },

  // WAN2.2 TI2V 5B → wan22-5b/
  { file: 'Wan2.2-TI2V-5B-Q4_K_M.gguf', targetDir: 'wan22-5b' },
  { file: 'Wan2.2-TI2V-5B-Q4_K_M.gguf.meta.json', targetDir: 'wan22-5b' },
  { file: 'Wan2.2_VAE.safetensors', targetDir: 'wan22-5b' },
  { file: 'Wan2.2_VAE.safetensors.meta.json', targetDir: 'wan22-5b' },
];

// Files to copy (duplicate) into wan22-5b since they're shared with wan22-turbo
const COPIES: CopyOp[] = [
  { file: 'umt5-xxl-encoder-Q8_0.gguf', targetDir: 'wan22-5b' },
];

async function main() {
  console.log('── Migrating models into group folders ──\n');

  // Collect unique target dirs
  const dirs = new Set([...MOVES.map(m => m.targetDir), ...COPIES.map(c => c.targetDir)]);
  for (const dir of dirs) {
    const dirPath = path.join(MODELS_DIR, dir);
    await fs.mkdir(dirPath, { recursive: true });
    console.log(`  Created ${dir}/`);
  }

  // Copy shared files first (before the originals get moved)
  for (const op of COPIES) {
    const src = path.join(MODELS_DIR, op.file);
    const dst = path.join(MODELS_DIR, op.targetDir, op.file);
    if (!existsSync(src)) {
      console.log(`  SKIP copy (not found): ${op.file}`);
      continue;
    }
    if (existsSync(dst)) {
      console.log(`  SKIP copy (already exists): ${op.targetDir}/${op.file}`);
      continue;
    }
    console.log(`  Copy ${op.file} → ${op.targetDir}/`);
    copyFileSync(src, dst);
  }

  // Move files
  for (const op of MOVES) {
    const src = path.join(MODELS_DIR, op.file);
    const dst = path.join(MODELS_DIR, op.targetDir, op.file);
    if (!existsSync(src)) {
      console.log(`  SKIP (not found): ${op.file}`);
      continue;
    }
    if (existsSync(dst)) {
      console.log(`  SKIP (already exists): ${op.targetDir}/${op.file}`);
      continue;
    }
    console.log(`  Move ${op.file} → ${op.targetDir}/`);
    await fs.rename(src, dst);
  }

  // Write .meta.json for each group dir
  for (const dir of dirs) {
    const metaPath = path.join(MODELS_DIR, dir, '.meta.json');
    const meta = { group: true, downloadedAt: new Date().toISOString() };
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
    console.log(`  Wrote ${dir}/.meta.json`);
  }

  // Show final state
  console.log('\n── Final .models/ contents:');
  const entries = await fs.readdir(MODELS_DIR);
  for (const entry of entries.sort()) {
    const stat = await fs.stat(path.join(MODELS_DIR, entry));
    if (stat.isDirectory()) {
      const files = await fs.readdir(path.join(MODELS_DIR, entry));
      const dataFiles = files.filter(f => !f.startsWith('.') && !f.endsWith('.meta.json'));
      console.log(`  ${entry}/  (${dataFiles.length} files)`);
      for (const f of dataFiles.sort()) {
        const fstat = await fs.stat(path.join(MODELS_DIR, entry, f));
        console.log(`    ${f}  (${(fstat.size / 1_048_576).toFixed(1)} MB)`);
      }
    } else {
      console.log(`  ${entry}  (${(stat.size / 1_048_576).toFixed(1)} MB)`);
    }
  }
}

main().catch(console.error);
