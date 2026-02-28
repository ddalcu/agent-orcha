import { z } from 'zod';
import type { StructuredTool, ContentPart } from './llm-types.ts';

export interface ToolConfig<T extends z.ZodObject<any>> {
  name: string;
  description: string;
  schema: T;
}

export function tool<T extends z.ZodObject<any>>(
  fn: (input: z.infer<T>) => Promise<string | ContentPart[]>,
  config: ToolConfig<T>
): StructuredTool {
  return {
    name: config.name,
    description: config.description,
    schema: config.schema,
    invoke: async (rawInput: Record<string, unknown>) => {
      const parsed = config.schema.parse(rawInput);
      return fn(parsed);
    },
  };
}
