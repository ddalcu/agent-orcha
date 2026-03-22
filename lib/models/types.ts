import { z } from 'zod';

export const ModelConfigSchema = z.object({
  type: z.string().describe('Model task type (e.g. text-to-image, text-to-speech)'),
  engine: z.enum(['sd-cpp']).describe('Inference runtime'),
  modelPath: z.string().optional().describe('Path to full model file (SD 1.x/2.x/XL)'),
  diffusionModel: z.string().optional().describe('Path to diffusion model (FLUX/SD3)'),
  clipL: z.string().optional().describe('Path to CLIP-L text encoder'),
  t5xxl: z.string().optional().describe('Path to T5-XXL text encoder (FLUX.1)'),
  llm: z.string().optional().describe('Path to LLM text encoder (FLUX.2 uses Qwen3)'),
  vae: z.string().optional().describe('Path to VAE model'),
  steps: z.number().optional().describe('Number of sampling steps'),
  description: z.string().default(''),
});

export const ModelsFileSchema = z.object({
  models: z.record(z.string(), ModelConfigSchema),
});

export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type ModelsFile = z.infer<typeof ModelsFileSchema>;
