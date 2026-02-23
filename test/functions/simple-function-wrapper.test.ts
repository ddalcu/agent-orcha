import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { wrapSimpleFunction } from '../../lib/functions/simple-function-wrapper.ts';

describe('wrapSimpleFunction', () => {
  it('should create a tool from a simple function', async () => {
    const tool = wrapSimpleFunction({
      name: 'greet',
      description: 'Greet someone',
      parameters: {
        name: { type: 'string', description: 'Name to greet' },
      },
      execute: async ({ name }) => `Hello, ${name}!`,
    });

    assert.equal(tool.name, 'greet');
    assert.equal(tool.description, 'Greet someone');

    const result = await tool.invoke({ name: 'Alice' });
    assert.equal(result, 'Hello, Alice!');
  });

  it('should handle function with no parameters', async () => {
    const tool = wrapSimpleFunction({
      name: 'ping',
      description: 'Ping',
      execute: async () => 'pong',
    });

    const result = await tool.invoke({});
    assert.equal(result, 'pong');
  });

  it('should convert non-string return values to strings', async () => {
    const tool = wrapSimpleFunction({
      name: 'count',
      description: 'Return a number',
      execute: async () => 42 as any,
    });

    const result = await tool.invoke({});
    assert.equal(result, '42');
  });

  it('should support all parameter types', () => {
    // Should not throw during creation
    const tool = wrapSimpleFunction({
      name: 'test',
      description: 'Test all types',
      parameters: {
        str: { type: 'string', description: 'A string' },
        num: { type: 'number', description: 'A number' },
        bool: { type: 'boolean', description: 'A boolean' },
        arr: { type: 'array', description: 'An array' },
        obj: { type: 'object', description: 'An object' },
        choice: { type: 'enum', description: 'A choice', values: ['a', 'b', 'c'] },
      },
      execute: async (args) => JSON.stringify(args),
    });

    assert.equal(tool.name, 'test');
  });

  it('should handle optional parameters with defaults', async () => {
    const tool = wrapSimpleFunction({
      name: 'greet',
      description: 'Greet',
      parameters: {
        name: { type: 'string', description: 'Name', required: false, default: 'World' },
      },
      execute: async ({ name }) => `Hello, ${name}!`,
    });

    assert.equal(tool.name, 'greet');
  });

  it('should throw for enum without values', () => {
    assert.throws(() => {
      wrapSimpleFunction({
        name: 'bad',
        description: 'Bad',
        parameters: {
          choice: { type: 'enum', description: 'No values' },
        },
        execute: async () => '',
      });
    }, /values/i);
  });
});
