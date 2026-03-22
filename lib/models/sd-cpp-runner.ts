import { execFile } from 'node:child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../logger.ts';
import { getSdCppBinaryPath } from './sd-cpp-binary.ts';

let _baseDir = '';

export function setSdCppBaseDir(dir: string): void {
  _baseDir = dir;
}

export interface SdCppRequest {
  modelPath?: string;
  diffusionModel?: string;
  clipL?: string;
  t5xxl?: string;
  llm?: string;
  vae?: string;
  prompt: string;
  outputDir: string;
  width?: number;
  height?: number;
  steps?: number;
}

export interface SdCppResult {
  imagePath: string;
  fileName: string;
}

export async function runSdCpp(request: SdCppRequest): Promise<SdCppResult> {
  const binary = await getSdCppBinaryPath(_baseDir);
  await fs.mkdir(request.outputDir, { recursive: true });

  const fileName = `img_${Date.now()}.png`;
  const outputPath = path.join(request.outputDir, fileName);

  const args: string[] = [];

  // Single-file model (SD 1.x/2.x/XL) vs multi-file (FLUX/SD3)
  if (request.diffusionModel) {
    args.push('--diffusion-model', request.diffusionModel);
    if (request.clipL) args.push('--clip_l', request.clipL);
    if (request.t5xxl) args.push('--t5xxl', request.t5xxl);
    if (request.llm) args.push('--llm', request.llm);
    if (request.vae) args.push('--vae', request.vae);
  } else if (request.modelPath) {
    args.push('-m', request.modelPath);
  }

  args.push('-p', request.prompt, '-o', outputPath);

  if (request.width) args.push('-W', String(request.width));
  if (request.height) args.push('-H', String(request.height));
  if (request.steps) args.push('--steps', String(request.steps));

  // FLUX.2 recommended flags
  if (request.llm) {
    args.push('--cfg-scale', '1.0', '--diffusion-fa', '--offload-to-cpu');
  }

  logger.info(`[sd-cpp] Generating image: "${request.prompt.slice(0, 80)}..."`);

  await new Promise<void>((resolve, reject) => {
    const binDir = path.dirname(binary);
    execFile(binary, args, {
      timeout: 600_000,
      env: {
        ...process.env,
        LD_LIBRARY_PATH: binDir,
        DYLD_LIBRARY_PATH: binDir,
      },
    }, (err, _stdout, stderr) => {
      if (err) {
        logger.error('[sd-cpp] Generation failed:', stderr || err.message);
        reject(new Error(`sd-cpp failed: ${stderr || err.message}`));
        return;
      }
      logger.info('[sd-cpp] Image generated:', outputPath);
      resolve();
    });
  });

  await fs.access(outputPath);
  return { imagePath: outputPath, fileName };
}
