import * as fs from 'fs/promises';
import * as path from 'path';
import { tool } from '../../types/tool-factory.ts';
import { z } from 'zod';
import type { StructuredTool } from '../../types/llm-types.ts';
import type { ImageModelConfig, TtsModelConfig } from '../../llm/llm-config.ts';
import { OmniModelCache } from '../../llm/providers/omni-model-cache.ts';
import { logger } from '../../logger.ts';

let _generatedDir = '';
let _workspaceRoot = '';

export function setGeneratedDir(dir: string): void {
  _generatedDir = dir;
}

export function setWorkspaceRoot(dir: string): void {
  _workspaceRoot = dir;
}

function createImageTool(name: string, config: ImageModelConfig): StructuredTool {
  return tool(
    async (args) => {
      const resolve = (p?: string) => p ? (path.isAbsolute(p) ? p : path.join(_workspaceRoot, p)) : undefined;
      const modelPath = resolve(config.modelPath);
      if (!modelPath) {
        return JSON.stringify({ __modelTask: true, error: 'No modelPath configured for image model' });
      }

      try {
        const imageModel = await OmniModelCache.getImageModel(modelPath, {
          ...(config.clipL ? { clipLPath: resolve(config.clipL) } : {}),
          ...(config.t5xxl ? { t5xxlPath: resolve(config.t5xxl) } : {}),
          ...(config.llm ? { llmPath: resolve(config.llm) } : {}),
          ...(config.vae ? { vaePath: resolve(config.vae) } : {}),
        });

        const buffer = await imageModel.generate(args.input, {
          steps: config.steps,
          width: config.width,
          height: config.height,
        });

        // Write PNG to .generated/
        await fs.mkdir(_generatedDir, { recursive: true });
        const fileName = `image_${Date.now()}.png`;
        const filePath = path.join(_generatedDir, fileName);
        await fs.writeFile(filePath, buffer);

        return JSON.stringify({
          __modelTask: true,
          task: 'text-to-image',
          image: `/generated/${fileName}`,
        });
      } catch (err) {
        logger.error(`[ModelToolFactory] Image generation failed:`, err);
        return JSON.stringify({ __modelTask: true, error: `Image generation failed: ${(err as Error).message}` });
      }
    },
    {
      name: `model_${name}`,
      description: `Generate an image using ${name}. ${config.description}`.trim(),
      schema: z.object({
        input: z.string().describe('Text prompt describing the image to generate'),
      }),
    },
  );
}

function createTtsTool(name: string, config: TtsModelConfig): StructuredTool {
  return tool(
    async (args) => {
      const resolve = (p: string) => path.isAbsolute(p) ? p : path.join(_workspaceRoot, p);
      const modelPath = resolve(config.modelPath);

      try {
        const ttsModel = await OmniModelCache.getTtsModel(modelPath, {
          engine: config.engine as 'kokoro' | 'qwen3',
        });

        const buffer = await ttsModel.speak(args.text, {
          voice: args.voice ?? config.voice,
          ...(args.referenceAudio ? { referenceAudioPath: resolve(args.referenceAudio) } : {}),
        });

        // Write WAV to .generated/
        await fs.mkdir(_generatedDir, { recursive: true });
        const fileName = `audio_${Date.now()}.wav`;
        const filePath = path.join(_generatedDir, fileName);
        await fs.writeFile(filePath, buffer);

        return JSON.stringify({
          __modelTask: true,
          task: 'text-to-speech',
          audio: `/generated/${fileName}`,
        });
      } catch (err) {
        logger.error(`[ModelToolFactory] TTS failed:`, err);
        return JSON.stringify({ __modelTask: true, error: `TTS failed: ${(err as Error).message}` });
      }
    },
    {
      name: `model_${name}`,
      description: `Generate speech using ${name}. ${config.description}`.trim(),
      schema: z.object({
        text: z.string().describe('Text to convert to speech'),
        voice: z.string().optional().describe('Voice name to use'),
        referenceAudio: z.string().optional().describe('Path to a reference audio WAV file for voice cloning (5-10 seconds, 24kHz mono recommended)'),
      }),
    },
  );
}

export function buildModelTools(
  imageConfigs: Array<{ name: string; config: ImageModelConfig }>,
  ttsConfigs: Array<{ name: string; config: TtsModelConfig }>,
): Map<string, StructuredTool> {
  const tools = new Map<string, StructuredTool>();
  for (const { name, config } of imageConfigs) {
    tools.set(name, createImageTool(name, config));
  }
  for (const { name, config } of ttsConfigs) {
    tools.set(name, createTtsTool(name, config));
  }
  return tools;
}
