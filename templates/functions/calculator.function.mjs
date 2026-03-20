/**
 * Calculator function
 *
 * Performs basic arithmetic operations on two numbers.
 */

export default {
  name: 'calculator',
  description: 'Performs basic arithmetic operations (add, subtract, multiply, divide) on two numbers.',

  parameters: {
    a: {
      type: 'number',
      description: 'The first number',
    },
    b: {
      type: 'number',
      description: 'The second number',
    },
    operation: {
      type: 'string',
      description: 'The operation to perform: "add", "subtract", "multiply", or "divide"',
    },
  },

  execute: async ({ a, b, operation }) => {
    // Validate inputs
    if (typeof a !== 'number' || typeof b !== 'number') {
      throw new Error('Both a and b must be numbers');
    }

    if (!operation) {
      throw new Error('Operation is required');
    }

    let result;
    switch (operation.toLowerCase()) {
      case 'add':
        result = a + b;
        return `${a} + ${b} = ${result}`;

      case 'subtract':
        result = a - b;
        return `${a} - ${b} = ${result}`;

      case 'multiply':
        result = a * b;
        return `${a} × ${b} = ${result}`;

      case 'divide':
        if (b === 0) {
          throw new Error('Cannot divide by zero');
        }
        result = a / b;
        return `${a} ÷ ${b} = ${result}`;

      default:
        throw new Error(`Unknown operation: ${operation}. Valid options: add, subtract, multiply, divide`);
    }
  },
};

export const metadata = {
  name: 'calculator',
  description: 'Performs basic arithmetic operations',
  version: '1.0.0',
  author: 'Agent Orchestrator',
  tags: ['math', 'calculator', 'arithmetic'],
};
