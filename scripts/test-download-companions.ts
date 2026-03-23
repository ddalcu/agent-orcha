/**
 * Test script: downloads FLUX.2 Klein companion files to verify
 * the subdirectory download path works end-to-end.
 *
 * Usage: node scripts/test-download-companions.ts
 */
import { ModelManager } from '../lib/local-llm/model-manager.ts';

const WORKSPACE = '/Users/david/.orcha/workspace';

const DOWNLOADS = [
  {
    repo: 'QuantStack/Wan2.2-TI2V-5B-GGUF',
    file: 'Wan2.2-TI2V-5B-Q4_K_M.gguf',
    label: 'WAN2.2 TI2V 5B Q4_K_M (diffusion model)',
  },
  {
    repo: 'QuantStack/Wan2.2-TI2V-5B-GGUF',
    file: 'VAE/Wan2.2_VAE.safetensors',
    label: 'WAN2.2 VAE (for TI2V 5B only)',
  },
  // UMT5-XXL already downloaded, skip
];

async function main() {
  const manager = new ModelManager(WORKSPACE);

  for (const dl of DOWNLOADS) {
    console.log(`\n── Downloading: ${dl.label}`);
    console.log(`   repo: ${dl.repo}  file: ${dl.file}`);

    const start = Date.now();
    let lastPercent = -1;

    try {
      const result = await manager.downloadModel(dl.repo, dl.file, (progress) => {
        const pct = progress.percent;
        if (pct !== lastPercent && pct % 5 === 0) {
          const mb = (progress.downloadedBytes / 1_048_576).toFixed(1);
          const totalMb = (progress.totalBytes / 1_048_576).toFixed(1);
          process.stdout.write(`\r   ${pct}%  ${mb} / ${totalMb} MB`);
          lastPercent = pct;
        }
      });

      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`\n   ✓ Done in ${elapsed}s → ${result.fileName} (${(result.sizeBytes / 1_048_576).toFixed(1)} MB)`);
      console.log(`     path: ${result.filePath}`);
    } catch (err) {
      console.error(`\n   ✗ Failed: ${(err as Error).message}`);
    }
  }

  console.log('\n── Verifying .models/ contents:');
  const models = await manager.listModels();
  for (const m of models) {
    console.log(`   ${m.fileName}  (${(m.sizeBytes / 1_048_576).toFixed(1)} MB)  repo: ${m.repo ?? 'n/a'}`);
  }
}

main().catch(console.error);
