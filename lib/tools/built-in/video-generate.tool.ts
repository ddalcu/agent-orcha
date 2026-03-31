import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from '../../utils/child-process.ts';
import { promisify } from 'util';
import { tool } from '../../types/tool-factory.ts';
import { z } from 'zod';
import type { StructuredTool } from '../../types/llm-types.ts';
import type { P2PManager } from '../../p2p/p2p-manager.ts';
import type { VideoSettings } from '../../p2p/types.ts';
import type { LeverageMode } from '../../agents/types.ts';
import { logger } from '../../logger.ts';

const execFileAsync = promisify(execFile);

interface VideoToolDeps {
  generatedDir: string;
  p2pManager?: P2PManager;
  leverage?: LeverageMode;
}

/**
 * Distribute frame ranges across available workers as evenly as possible.
 */
function distributeFrames(totalFrames: number, workerCount: number): Array<{ start: number; end: number }> {
  const framesPerWorker = Math.ceil(totalFrames / workerCount);
  const ranges: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < workerCount; i++) {
    const start = i * framesPerWorker;
    const end = Math.min(start + framesPerWorker, totalFrames);
    if (start < totalFrames) {
      ranges.push({ start, end });
    }
  }
  return ranges;
}

/**
 * Stitch PNG frames into an MP4 video using ffmpeg.
 * Falls back to creating an animated GIF if ffmpeg is unavailable.
 */
async function stitchFrames(framesDir: string, outputPath: string, fps: number): Promise<string> {
  const framePattern = path.join(framesDir, 'frame_%06d.png');
  const isMac = process.platform === 'darwin';
  const encoder = isMac ? 'h264_videotoolbox' : 'libx264';
  const encoderArgs = isMac
    ? ['-c:v', encoder, '-pix_fmt', 'yuv420p', '-q:v', '65']
    : ['-c:v', encoder, '-pix_fmt', 'yuv420p', '-crf', '23', '-preset', 'medium'];

  try {
    logger.info(`[VideoTool] ffmpeg: encoding MP4 with ${encoder} (minterpolate ${fps}->${fps * 2}fps)...`);
    const t0 = Date.now();
    await execFileAsync('ffmpeg', [
      '-y',
      '-framerate', String(fps),
      '-i', framePattern,
      '-vf', `minterpolate=fps=${fps * 2}:mi_mode=blend`,
      ...encoderArgs,
      outputPath,
    ], { timeout: 300_000 });
    logger.info(`[VideoTool] ffmpeg: MP4 encoded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return outputPath;
  } catch (ffmpegErr) {
    logger.warn('[VideoTool] ffmpeg MP4 failed, trying GIF fallback:', ffmpegErr);

    const gifPath = outputPath.replace(/\.mp4$/, '.gif');
    try {
      await execFileAsync('ffmpeg', [
        '-y',
        '-framerate', String(fps),
        '-i', framePattern,
        '-vf', `fps=${fps},scale=-1:-1:flags=lanczos`,
        gifPath,
      ], { timeout: 120_000 });
      return gifPath;
    } catch (gifErr) {
      logger.warn('[VideoTool] ffmpeg unavailable — returning frames directory:', gifErr);
      return framesDir;
    }
  }
}

/**
 * Resolve the image model from the image config (for frame-by-frame generation).
 */
async function resolveImageModel(generatedDir: string) {
  const { OmniModelCache } = await import('../../llm/providers/omni-model-cache.ts');
  const { getImageConfig } = await import('../../llm/llm-config.ts');

  const imageConfig = getImageConfig('omni');
  if (!imageConfig?.modelPath) {
    throw new Error('No image model configured — load an image model first');
  }

  const resolve = (p: string) => path.isAbsolute(p) ? p : path.join(generatedDir, '..', p);
  const modelPath = resolve(imageConfig.modelPath);

  return OmniModelCache.getImageModel(modelPath, {
    ...(imageConfig.t5xxl ? { t5xxlPath: resolve(imageConfig.t5xxl) } : {}),
    ...(imageConfig.llm ? { llmPath: resolve(imageConfig.llm) } : {}),
    ...(imageConfig.vae ? { vaePath: resolve(imageConfig.vae) } : {}),
    ...(imageConfig.clipL ? { clipLPath: resolve(imageConfig.clipL) } : {}),
  });
}

/**
 * Resolve the video model from the video config (for native video generation).
 */
async function resolveVideoModel(generatedDir: string) {
  const { OmniModelCache } = await import('../../llm/providers/omni-model-cache.ts');
  const { getVideoConfig } = await import('../../llm/llm-config.ts');

  const videoConfig = getVideoConfig('omni');
  if (!videoConfig?.modelPath) {
    throw new Error('No video model configured — load a video model first');
  }

  const resolve = (p: string) => path.isAbsolute(p) ? p : path.join(generatedDir, '..', p);
  const modelPath = resolve(videoConfig.modelPath);

  return OmniModelCache.getVideoModel(modelPath, {
    ...(videoConfig.t5xxl ? { t5xxlPath: resolve(videoConfig.t5xxl) } : {}),
    ...(videoConfig.llm ? { llmPath: resolve(videoConfig.llm) } : {}),
    ...(videoConfig.vae ? { vaePath: resolve(videoConfig.vae) } : {}),
    ...(videoConfig.clipL ? { clipLPath: resolve(videoConfig.clipL) } : {}),
  });
}

/**
 * Check if the configured model is a native video model (WAN) that supports generateVideo().
 */
async function isNativeVideoModel(): Promise<boolean> {
  try {
    const { getVideoConfig } = await import('../../llm/llm-config.ts');
    const config = getVideoConfig('omni');
    return config.provider === 'omni' && !!config.modelPath;
  } catch {
    return false;
  }
}

/**
 * Generate all frames natively via generateVideo() (WAN models).
 * WAN generates temporally coherent frames in a single pass.
 */
async function generateNativeVideoFrames(
  generatedDir: string,
  prompt: string,
  totalFrames: number,
  settings: VideoSettings,
  frameMap: Map<number, Buffer>,
  peerContributions: Map<string, number>,
): Promise<void> {
  const videoModel = await resolveVideoModel(generatedDir);

  logger.info(`[VideoTool] GPU: generating ${totalFrames} frames (${settings.width}x${settings.height}, ${settings.steps} steps, cfg ${settings.cfgScale})...`);
  const t0 = Date.now();
  const frames = await videoModel.generateVideo(prompt, {
    videoFrames: totalFrames,
    width: settings.width,
    height: settings.height,
    steps: settings.steps,
    cfgScale: settings.cfgScale,
    flowShift: settings.flowShift,
    ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
  });
  const genSec = ((Date.now() - t0) / 1000).toFixed(1);

  for (let i = 0; i < frames.length; i++) {
    frameMap.set(i, frames[i]!);
  }
  peerContributions.set('local', frames.length);
  logger.info(`[VideoTool] GPU: ${frames.length} frames generated in ${genSec}s`);
}

/**
 * Generate frames locally using per-frame image generation (for non-WAN models).
 */
async function generateLocalFrames(
  generatedDir: string,
  prompt: string,
  range: { start: number; end: number },
  totalFrames: number,
  settings: VideoSettings,
  frameMap: Map<number, Buffer>,
  peerContributions: Map<string, number>,
): Promise<void> {
  const imageModel = await resolveImageModel(generatedDir);

  for (let i = range.start; i < range.end; i++) {
    const progress = i / Math.max(totalFrames - 1, 1);
    const timeLabel = progress < 0.33 ? 'beginning' : progress < 0.66 ? 'middle' : 'end';
    const framePrompt = `${prompt}, continuous animation sequence, ${timeLabel} of scene, smooth motion, consistent style and composition, frame ${i + 1} of ${totalFrames}`;
    const frameSeed = settings.seed !== undefined ? settings.seed + i : undefined;

    const buffer = await imageModel.generate(framePrompt, {
      steps: settings.steps,
      width: settings.width,
      height: settings.height,
      ...(settings.cfgScale !== undefined ? { cfgScale: settings.cfgScale } : {}),
      ...(frameSeed !== undefined ? { seed: frameSeed } : {}),
    });
    frameMap.set(i, buffer);
    peerContributions.set('local', (peerContributions.get('local') ?? 0) + 1);
    logger.info(`[VideoTool] Frame ${i + 1}/${totalFrames} from local (${frameMap.size}/${totalFrames} total)`);
  }
}

/**
 * Generate frames on a remote peer via P2P.
 */
async function generateRemoteFrames(
  p2pManager: P2PManager,
  peer: { peerId: string; name: string; peerName: string },
  prompt: string,
  range: { start: number; end: number },
  totalFrames: number,
  settings: VideoSettings,
  frameMap: Map<number, Buffer>,
  peerContributions: Map<string, number>,
): Promise<void> {
  for (let i = range.start; i < range.end; i++) {
    const progress = i / Math.max(totalFrames - 1, 1);
    const timeLabel = progress < 0.33 ? 'beginning' : progress < 0.66 ? 'middle' : 'end';
    const framePrompt = `${prompt}, continuous animation sequence, ${timeLabel} of scene, smooth motion, consistent style and composition, frame ${i + 1} of ${totalFrames}`;
    const frameSeed = settings.seed !== undefined ? settings.seed + i : undefined;

    const result = await p2pManager.invokeRemoteModelTask(
      peer.peerId, peer.name, 'video_frame',
      {
        prompt: framePrompt, width: settings.width, height: settings.height,
        steps: settings.steps, cfgScale: settings.cfgScale, flowShift: settings.flowShift,
        ...(frameSeed !== undefined ? { seed: frameSeed } : {}),
        frameIndex: i, totalFrames,
      },
    );
    frameMap.set(i, Buffer.from(result.data, 'base64'));
    peerContributions.set(peer.peerName, (peerContributions.get(peer.peerName) ?? 0) + 1);
    logger.info(`[VideoTool] Frame ${i + 1}/${totalFrames} from "${peer.peerName}" (${frameMap.size}/${totalFrames} total)`);
  }
}

/**
 * Check if a local image model is available (for frame-by-frame generation).
 */
async function hasLocalImageModel(): Promise<boolean> {
  const { getImageConfig } = await import('../../llm/llm-config.ts');
  return !!getImageConfig('omni')?.modelPath;
}

/**
 * Collect frames, write to disk, and stitch into video.
 */
async function finalizeVideo(
  frameMap: Map<number, Buffer>,
  totalFrames: number,
  fps: number,
  generatedDir: string,
  peerContributions: Map<string, number>,
  errors: string[],
): Promise<string> {
  const videoId = `video_${Date.now()}`;
  const framesDir = path.join(generatedDir, videoId);
  await fs.mkdir(framesDir, { recursive: true });

  logger.info(`[VideoTool] Disk: writing ${frameMap.size} PNG frames to ${framesDir}...`);
  const t0 = Date.now();
  let writtenFrames = 0;
  let totalBytes = 0;
  for (let i = 0; i < totalFrames; i++) {
    const frameData = frameMap.get(i);
    if (frameData) {
      const paddedIndex = String(i + 1).padStart(6, '0');
      await fs.writeFile(path.join(framesDir, `frame_${paddedIndex}.png`), frameData);
      writtenFrames++;
      totalBytes += frameData.length;
    }
  }
  logger.info(`[VideoTool] Disk: ${writtenFrames} frames written (${(totalBytes / 1024 / 1024).toFixed(1)} MB) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  if (writtenFrames === 0) {
    return JSON.stringify({
      __modelTask: true,
      error: `No frames were generated. Errors: ${errors.join('; ')}`,
    });
  }

  await fs.mkdir(generatedDir, { recursive: true });
  const outputPath = path.join(generatedDir, `${videoId}.mp4`);
  const result = await stitchFrames(framesDir, outputPath, fps);
  const relativePath = `/generated/${path.relative(generatedDir, result)}`;

  const contributions: Record<string, number> = {};
  for (const [name, count] of peerContributions) {
    contributions[name] = count;
  }

  return JSON.stringify({
    __modelTask: true,
    task: 'text-to-video',
    video: relativePath,
    framesGenerated: writtenFrames,
    totalFrames,
    peersUsed: Object.keys(contributions).length,
    peerContributions: contributions,
    duration: `${(totalFrames / fps).toFixed(1)}s at ${fps}fps`,
    ...(errors.length ? { warnings: errors } : {}),
  });
}

export function createVideoGenerateTool(deps: VideoToolDeps): StructuredTool {
  return tool(
    async (args) => {
      const { prompt, model, totalFrames, width, height, cfgScale, steps, flowShift, seed, fps } = args;
      const modelRef = model || 'wan2.2';
      const mode = deps.leverage || false;

      const settings: VideoSettings = {
        totalFrames, width, height, cfgScale, steps, flowShift, fps,
        ...(seed !== undefined ? { seed } : {}),
      };

      const frameMap = new Map<number, Buffer>();
      const errors: string[] = [];
      const peerContributions = new Map<string, number>();

      try {
        const nativeVideo = await isNativeVideoModel();

        // Native video models (WAN) generate all frames in a single pass —
        // frame-by-frame distribution is not applicable.
        if (nativeVideo) {
          if (mode === 'remote-only') {
            return JSON.stringify({
              __modelTask: true,
              error: 'Native video models (WAN) require local generation — remote-only mode is not supported.',
            });
          }
          await generateNativeVideoFrames(deps.generatedDir, prompt, totalFrames, settings, frameMap, peerContributions)
            .catch(err => { errors.push(`native: ${(err as Error).message}`); });
          const actualFrames = frameMap.size || totalFrames;
          return finalizeVideo(frameMap, actualFrames, fps, deps.generatedDir, peerContributions, errors);
        }

        // Frame-by-frame generation for standard image models (FLUX, SD, etc.)
        const hasLocal = await hasLocalImageModel();
        let remotePeers: Array<{ peerId: string; name: string; peerName: string }> = [];

        if (mode && deps.p2pManager) {
          remotePeers = deps.p2pManager.getRemoteModelsByName(modelRef, 'video');
        }

        // ── remote-only: only use P2P peers ──
        if (mode === 'remote-only') {
          if (remotePeers.length === 0) {
            return JSON.stringify({
              __modelTask: true,
              error: `No remote peers found with model "${modelRef}" (remote-only mode).`,
            });
          }
          logger.info(`[VideoTool] remote-only: ${remotePeers.length} peer(s) for ${totalFrames} frames`);
          const ranges = distributeFrames(totalFrames, remotePeers.length);
          const tasks: Promise<void>[] = [];
          for (let idx = 0; idx < remotePeers.length; idx++) {
            const range = ranges[idx];
            if (!range) continue;
            const peer = remotePeers[idx]!;
            tasks.push(generateRemoteFrames(deps.p2pManager!, peer, prompt, range, totalFrames, settings, frameMap, peerContributions)
              .catch(err => { errors.push(`${peer.peerName}: ${(err as Error).message}`); }));
          }
          await Promise.all(tasks);
          return finalizeVideo(frameMap, totalFrames, fps, deps.generatedDir, peerContributions, errors);
        }

        // ── remote-first: try P2P, fall back to local ──
        if (mode === 'remote-first' && deps.p2pManager) {
          const totalWorkers = remotePeers.length + (hasLocal ? 1 : 0);
          if (totalWorkers === 0) {
            return JSON.stringify({ __modelTask: true, error: `No workers available for model "${modelRef}".` });
          }
          logger.info(`[VideoTool] remote-first: ${totalWorkers} worker(s) (${remotePeers.length} remote${hasLocal ? ' + local' : ''}) for ${totalFrames} frames`);
          const ranges = distributeFrames(totalFrames, totalWorkers);
          const tasks: Promise<void>[] = [];
          for (let idx = 0; idx < remotePeers.length; idx++) {
            const range = ranges[idx];
            if (!range) continue;
            const peer = remotePeers[idx]!;
            tasks.push(generateRemoteFrames(deps.p2pManager, peer, prompt, range, totalFrames, settings, frameMap, peerContributions)
              .catch(err => { errors.push(`${peer.peerName}: ${(err as Error).message}`); }));
          }
          if (hasLocal) {
            const localRange = ranges[remotePeers.length];
            if (localRange) {
              tasks.push(generateLocalFrames(deps.generatedDir, prompt, localRange, totalFrames, settings, frameMap, peerContributions)
                .catch(err => { errors.push(`local: ${(err as Error).message}`); }));
            }
          }
          await Promise.all(tasks);
          return finalizeVideo(frameMap, totalFrames, fps, deps.generatedDir, peerContributions, errors);
        }

        // ── local-first (default): generate locally, use P2P as fallback for extra workers ──
        if (!hasLocal && remotePeers.length === 0) {
          return JSON.stringify({
            __modelTask: true,
            error: `No video/image model loaded locally and no remote peers available. Load a video/image model first.`,
          });
        }

        // Distribute across local + any P2P peers if leverage is enabled
        const useRemote = mode && deps.p2pManager && remotePeers.length > 0;
        const totalWorkers = (hasLocal ? 1 : 0) + (useRemote ? remotePeers.length : 0);
        logger.info(`[VideoTool] local-first: ${totalWorkers} worker(s) (${useRemote ? remotePeers.length + ' remote + ' : ''}${hasLocal ? 'local' : 'no local'}) for ${totalFrames} frames`);
        const ranges = distributeFrames(totalFrames, totalWorkers);
        const tasks: Promise<void>[] = [];

        let rangeIdx = 0;
        // Local gets first range
        if (hasLocal) {
          const localRange = ranges[rangeIdx++];
          if (localRange) {
            tasks.push(generateLocalFrames(deps.generatedDir, prompt, localRange, totalFrames, settings, frameMap, peerContributions)
              .catch(err => { errors.push(`local: ${(err as Error).message}`); }));
          }
        }
        // Remote peers get remaining ranges
        if (useRemote) {
          for (const peer of remotePeers) {
            const range = ranges[rangeIdx++];
            if (!range) break;
            tasks.push(generateRemoteFrames(deps.p2pManager!, peer, prompt, range, totalFrames, settings, frameMap, peerContributions)
              .catch(err => { errors.push(`${peer.peerName}: ${(err as Error).message}`); }));
          }
        }

        await Promise.all(tasks);
        return finalizeVideo(frameMap, totalFrames, fps, deps.generatedDir, peerContributions, errors);
      } catch (err) {
        logger.error('[VideoTool] Video generation failed:', err);
        return JSON.stringify({
          __modelTask: true,
          error: `Video generation failed: ${(err as Error).message}`,
        });
      }
    },
    {
      name: 'generate_video',
      description:
        'Generate a video from a text prompt. Native video models (WAN) produce temporally coherent frames in a single pass. ' +
        'Standard image models generate frames individually then stitch. Use video_settings from session context if available.',
      schema: z.object({
        prompt: z.string().describe('Text prompt describing the video to generate'),
        model: z.string().optional().describe('Model name (default: wan2.2). Used for P2P peer matching when leverage is enabled.'),
        totalFrames: z.number().default(9).describe('Frames to generate. WAN requires 1+4n (9, 13, 17, 21, 25, 33, 49, 81). Default 9 for quick preview.'),
        width: z.number().default(832).describe('Frame width (WAN 480p: 832 landscape, 480 portrait, 624 square)'),
        height: z.number().default(480).describe('Frame height (WAN 480p: 480 landscape, 832 portrait, 624 square)'),
        cfgScale: z.number().default(5).describe('CFG guidance scale (WAN TI2V-5B official: 5.0)'),
        steps: z.number().default(6).describe('Diffusion steps — 6 quick, 30 standard, 50 official quality'),
        flowShift: z.number().default(5).describe('Flow shift (TI2V-5B official: 5.0, sd-cli default: 3.0)'),
        seed: z.number().optional().describe('Random seed for reproducibility'),
        fps: z.number().default(16).describe('Output frames per second (TI2V-5B native: 24, playback: 16)'),
      }),
    },
  );
}
