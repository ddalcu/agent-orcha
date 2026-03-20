import { z } from 'zod';

/**
 * Convert a JSON Schema object to a Zod schema.
 * Handles: string, number, integer, boolean, array, object, required/optional.
 */
export function convertJsonSchemaToZod(schema: unknown): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const jsonSchema = schema as { properties?: Record<string, { type?: string; description?: string }>; required?: string[] };
  const properties = jsonSchema.properties ?? {};
  const required = new Set(jsonSchema.required ?? []);

  const zodShape: Record<string, z.ZodTypeAny> = {};

  for (const [key, prop] of Object.entries(properties)) {
    let zodType: z.ZodTypeAny;

    switch (prop.type) {
      case 'string':
        zodType = z.string();
        break;
      case 'number':
      case 'integer':
        zodType = z.number();
        break;
      case 'boolean':
        zodType = z.boolean();
        break;
      case 'array':
        zodType = z.array(z.unknown());
        break;
      case 'object':
        zodType = z.record(z.unknown());
        break;
      default:
        zodType = z.unknown();
    }

    if (prop.description) {
      zodType = zodType.describe(prop.description);
    }

    zodShape[key] = required.has(key) ? zodType : zodType.optional();
  }

  return z.object(zodShape);
}
