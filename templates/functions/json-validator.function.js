/**
 * JSON validator function
 *
 * Validates JSON structure and checks for required fields.
 */

export default {
  name: 'json-validator',
  description: 'Validates a JSON object and checks for required fields. Returns validation results with detailed information.',

  parameters: {
    data: {
      type: 'object',
      description: 'The JSON object to validate',
    },
    requiredFields: {
      type: 'array',
      description: 'Array of field names that must be present in the data (optional)',
    },
  },

  execute: async ({ data, requiredFields = [] }) => {
    if (!data || typeof data !== 'object') {
      throw new Error('Data must be a valid object');
    }

    const results = {
      valid: true,
      fieldCount: 0,
      fields: [],
      missingFields: [],
      errors: [],
    };

    // Count and list all fields
    const fields = Object.keys(data);
    results.fieldCount = fields.length;
    results.fields = fields;

    // Check required fields
    if (requiredFields && Array.isArray(requiredFields) && requiredFields.length > 0) {
      for (const field of requiredFields) {
        if (!data.hasOwnProperty(field)) {
          results.missingFields.push(field);
          results.errors.push(`Missing required field: ${field}`);
          results.valid = false;
        }
      }
    }

    // Check for null or undefined values
    for (const [key, value] of Object.entries(data)) {
      if (value === null) {
        results.errors.push(`Field "${key}" is null`);
      } else if (value === undefined) {
        results.errors.push(`Field "${key}" is undefined`);
      }
    }

    // Build response message
    let message = `Validation ${results.valid ? 'PASSED' : 'FAILED'}\n\n`;
    message += `Total fields: ${results.fieldCount}\n`;
    message += `Fields: ${results.fields.join(', ')}\n`;

    if (results.missingFields.length > 0) {
      message += `\nMissing required fields: ${results.missingFields.join(', ')}\n`;
    }

    if (results.errors.length > 0) {
      message += `\nErrors:\n${results.errors.map(e => `  - ${e}`).join('\n')}`;
    } else {
      message += '\nNo errors found!';
    }

    return message;
  },
};

export const metadata = {
  name: 'json-validator',
  description: 'Validates JSON objects and checks for required fields',
  version: '1.0.0',
  author: 'Agent Orchestrator',
  tags: ['json', 'validation', 'data'],
};
