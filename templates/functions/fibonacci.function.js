/**
 * Fibonacci calculator function - Simple format example
 *
 * This demonstrates the simple function format that requires no imports.
 * Just export a default object with name, description, parameters, and execute.
 */

export default {
  name: 'fibonacci',
  description: 'Returns the nth Fibonacci number (0-based indexing).',

  parameters: {
    n: {
      type: 'number',
      description: 'The index of the Fibonacci number (0-based). For example, n=0 returns 0, n=5 returns 5.',
    },
  },

  execute: async ({ n }) => {
    // Validate input
    if (n < 0) {
      throw new Error('Index must be non-negative');
    }
    if (!Number.isInteger(n)) {
      throw new Error('Index must be an integer');
    }
    if (n > 100) {
      throw new Error('Index too large (max 100 to prevent overflow)');
    }

    // Calculate Fibonacci number
    if (n === 0) return `Fibonacci(${n}) = 0`;
    if (n === 1) return `Fibonacci(${n}) = 1`;

    let prev = 0;
    let curr = 1;

    for (let i = 2; i <= n; i++) {
      const next = prev + curr;
      prev = curr;
      curr = next;
    }

    return `Fibonacci(${n}) = ${curr}`;
  },
};

// Optional: Export metadata for discovery
export const metadata = {
  name: 'fibonacci',
  description: 'Returns the nth Fibonacci number',
  version: '1.0.0',
  author: 'Agent Orchestrator',
  tags: ['math', 'fibonacci'],
};
