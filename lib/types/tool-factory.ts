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
      const result = config.schema.safeParse(rawInput);
      if (!result.success) {
        const fields = result.error.issues.map((i: z.ZodIssue) => `${i.path.join('.')}: ${i.message}`).join(', ');
        const provided = Object.keys(rawInput);
        throw new Error(
          `Invalid args for ${config.name}: ${fields}. ` +
          `You provided: ${provided.length ? provided.join(', ') : '(empty)'}. ` +
          'Please include all required fields.'
        );
      }
      return fn(result.data);
    },
  };
}
