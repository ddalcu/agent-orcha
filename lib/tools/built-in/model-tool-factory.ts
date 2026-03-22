import * as path from 'path';
import { tool } from '../../types/tool-factory.ts';
import { z } from 'zod';
import type { StructuredTool } from '../../types/llm-types.ts';
import type { ModelConfig } from '../../models/types.ts';
import { runSdCpp } from '../../models/sd-cpp-runner.ts';

let _generatedDir = '';
let _workspaceRoot = '';

export function setGeneratedDir(dir: string): void {
  _generatedDir = dir;
}

export function setWorkspaceRoot(dir: string): void {
  _workspaceRoot = dir;
}

function createSdCppTool(name: string, config: ModelConfig): StructuredTool {
  return tool(
    async (args) => {
      if (!config.modelPath && !config.diffusionModel) {
        return JSON.stringify({ __modelTask: true, error: 'No modelPath or diffusionModel configured for sd-cpp engine' });
      }
      const resolve = (p?: string) => p ? (path.isAbsolute(p) ? p : path.join(_workspaceRoot, p)) : undefined;
      const result = await runSdCpp({
        modelPath: resolve(config.modelPath),
        diffusionModel: resolve(config.diffusionModel),
        clipL: resolve(config.clipL),
        t5xxl: resolve(config.t5xxl),
        llm: resolve(config.llm),
        vae: resolve(config.vae),
        prompt: args.input,
        outputDir: _generatedDir,
        steps: config.steps,
      });
      return JSON.stringify({
        __modelTask: true,
        task: config.type,
        image: `/generated/${result.fileName}`,
      });
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

export function createModelTool(name: string, config: ModelConfig): StructuredTool {
  return createSdCppTool(name, config);
}

export function buildModelTools(
  configs: Array<{ name: string; config: ModelConfig }>,
): Map<string, StructuredTool> {
  const tools = new Map<string, StructuredTool>();
  for (const { name, config } of configs) {
    tools.set(name, createModelTool(name, config));
  }
  return tools;
}
