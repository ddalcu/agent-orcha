import { tool } from '@langchain/core/tools';
import { z } from 'zod';

/**
 * Simple function parameter definition (no imports needed for user code)
 */
export interface SimpleFunctionParameter {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'enum';
  description: string;
  values?: string[]; // For enum type
  required?: boolean;
  default?: any;
}

/**
 * Simple function definition (no imports needed for user code)
 */
export interface SimpleFunctionDefinition {
  name: string;
  description: string;
  parameters?: Record<string, SimpleFunctionParameter>;
  execute: (args: any) => Promise<string> | string;
}

/**
 * Converts a simple parameter definition to a Zod schema
 */
function parameterToZodSchema(param: SimpleFunctionParameter): z.ZodTypeAny {
  let schema: z.ZodTypeAny;

  switch (param.type) {
    case 'string':
      schema = z.string();
      break;
    case 'number':
      schema = z.number();
      break;
    case 'boolean':
      schema = z.boolean();
      break;
    case 'array':
      schema = z.array(z.any());
      break;
    case 'object':
      schema = z.object({}).passthrough();
      break;
    case 'enum':
      if (!param.values || param.values.length === 0) {
        throw new Error('Enum parameter must have values array');
      }
      schema = z.enum(param.values as [string, ...string[]]);
      break;
    default:
      throw new Error(`Unsupported parameter type: ${param.type}`);
  }

  // Add description
  schema = schema.describe(param.description);

  // Handle optional/default
  if (param.required === false || param.default !== undefined) {
    schema = schema.optional();
    if (param.default !== undefined) {
      schema = schema.default(param.default);
    }
  }

  return schema;
}

/**
 * Wraps a simple function definition into a LangChain StructuredTool
 */
export function wrapSimpleFunction(definition: SimpleFunctionDefinition) {
  // Build Zod schema from parameters
  const schemaShape: Record<string, z.ZodTypeAny> = {};

  if (definition.parameters) {
    for (const [key, param] of Object.entries(definition.parameters)) {
      schemaShape[key] = parameterToZodSchema(param);
    }
  }

  const schema = z.object(schemaShape);

  // Create the LangChain tool
  return tool(
    async (args) => {
      const result = await definition.execute(args);
      return String(result);
    },
    {
      name: definition.name,
      description: definition.description,
      schema,
    }
  );
}
