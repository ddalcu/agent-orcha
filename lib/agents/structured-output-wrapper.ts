import type { ChatModel } from '../types/llm-types.ts';
import type { OutputConfig } from './types.ts';
import { logger } from '../logger.ts';

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export class StructuredOutputWrapper {
  /**
   * Wrap LLM with structured output if configured
   * Returns wrapped LLM or original LLM if not structured
   */
  static wrapLLM(llm: ChatModel, outputConfig?: OutputConfig): ChatModel {
    // If no output config or format is not 'structured', return original LLM
    if (!outputConfig || outputConfig.format !== 'structured') {
      return llm;
    }

    // Ensure schema is provided for structured output
    if (!outputConfig.schema) {
      logger.warn('[StructuredOutputWrapper] Structured output requested but no schema provided, using original LLM');
      return llm;
    }

    try {
      // Use withStructuredOutput to enforce JSON schema
      logger.info('[StructuredOutputWrapper] Wrapping LLM with structured output');
      const wrappedLLM = llm.withStructuredOutput(outputConfig.schema);
      return wrappedLLM as ChatModel;
    } catch (error) {
      logger.error('[StructuredOutputWrapper] Failed to wrap LLM with structured output:', error);
      return llm;
    }
  }

  /**
   * Validate output against schema
   * Returns validation result with error message if invalid
   */
  static validateOutput(output: unknown, schema: Record<string, unknown>): ValidationResult {
    try {
      // Basic validation - check if output is an object
      if (typeof output !== 'object' || output === null) {
        return {
          valid: false,
          error: 'Output must be an object',
        };
      }

      const outputObj = output as Record<string, unknown>;

      // Check required properties
      if (schema.required && Array.isArray(schema.required)) {
        for (const requiredField of schema.required) {
          if (!(requiredField in outputObj)) {
            return {
              valid: false,
              error: `Missing required field: ${requiredField}`,
            };
          }
        }
      }

      // Check property types (basic validation)
      if (schema.properties && typeof schema.properties === 'object') {
        const properties = schema.properties as Record<string, unknown>;
        for (const [key, value] of Object.entries(outputObj)) {
          const propertySchema = properties[key];
          if (!propertySchema) continue;

          const propSchemaObj = propertySchema as Record<string, unknown>;
          const expectedType = propSchemaObj.type;

          if (expectedType === 'string' && typeof value !== 'string') {
            return {
              valid: false,
              error: `Field '${key}' must be a string`,
            };
          }

          if (expectedType === 'number' && typeof value !== 'number') {
            return {
              valid: false,
              error: `Field '${key}' must be a number`,
            };
          }

          if (expectedType === 'boolean' && typeof value !== 'boolean') {
            return {
              valid: false,
              error: `Field '${key}' must be a boolean`,
            };
          }

          if (expectedType === 'array' && !Array.isArray(value)) {
            return {
              valid: false,
              error: `Field '${key}' must be an array`,
            };
          }

          if (expectedType === 'object' && (typeof value !== 'object' || value === null)) {
            return {
              valid: false,
              error: `Field '${key}' must be an object`,
            };
          }
        }
      }

      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
