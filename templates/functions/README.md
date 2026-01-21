# Custom Functions

This directory contains custom function tools that can be used by agents in the orchestrator.

## Overview

Functions are JavaScript files that export tools with metadata. They provide a way to extend agent capabilities with custom logic and operations.

**No dependencies required!** Functions use a simple format that requires no npm packages or imports.

## Creating a Function

Functions must follow this structure:

1. File name must end with `.function.js`
2. Must export a default object with `name`, `description`, `parameters`, and `execute`
3. Optionally export metadata for better documentation

### Simple Format (Recommended)

**No imports needed!** Just export a plain JavaScript object:

```javascript
/**
 * Your function description
 */
export default {
  name: 'your-function-name',
  description: 'A clear description of what this function does',

  parameters: {
    param1: {
      type: 'number',
      description: 'Description of parameter 1',
    },
    param2: {
      type: 'string',
      description: 'Description of parameter 2',
    },
    optionalParam: {
      type: 'boolean',
      description: 'An optional parameter',
      required: false,
      default: true,
    },
  },

  execute: async ({ param1, param2, optionalParam }) => {
    // Your implementation here
    return `Result: ${param1 + param2}`;
  },
};

// Optional: Export metadata for discovery
export const metadata = {
  name: 'your-function-name',
  description: 'Function description',
  version: '1.0.0',
  author: 'Your Name',
  tags: ['category1', 'category2'],
};
```

### Parameter Types

Supported parameter types:

- `'string'` - String value
- `'number'` - Numeric value
- `'boolean'` - Boolean true/false
- `'array'` - Array of values
- `'object'` - Object/JSON structure
- `'enum'` - One of a fixed set of values (requires `values` array)

### Enum Parameters

For parameters with a fixed set of allowed values:

```javascript
parameters: {
  operation: {
    type: 'enum',
    values: ['add', 'subtract', 'multiply', 'divide'],
    description: 'The operation to perform',
  },
}
```

## Using Functions in Agents

To use a function in an agent, add it to the agent's `tools` array using the `function:` prefix:

```yaml
name: my-agent
description: An agent that uses custom functions

tools:
  - function:fibonacci  # References fibonacci.function.js
  - function:your-function-name

# ... rest of agent configuration
```

## Available Functions

### fibonacci

**File:** `fibonacci.function.js`

**Description:** Returns the nth Fibonacci number

**Parameters:**
- `n` (number) - The index (0-based, max 100)

**Examples:**
- Fibonacci(0) returns: 0
- Fibonacci(5) returns: 5
- Fibonacci(10) returns: 55

**Usage in agent:**
```yaml
tools:
  - function:fibonacci
```

## Best Practices

1. **Error Handling**: Always validate inputs and handle errors gracefully
2. **Descriptive Names**: Use clear, descriptive names for functions and parameters
3. **Documentation**: Include JSDoc comments explaining what the function does
4. **Parameter Descriptions**: Provide clear descriptions for each parameter
5. **Metadata**: Export metadata to make functions discoverable and well-documented
6. **Async Operations**: Use async/await for operations that involve I/O or external calls
7. **Return Values**: Return strings or serializable objects that agents can interpret

## Development Tips

- Functions are loaded automatically on orchestrator initialization
- Function names must be unique across all loaded functions
- The simple format requires no npm packages or dependencies
- Test functions independently before integrating with agents
- Use the simple format unless you need advanced LangChain features

## Example Agent Using Fibonacci

```yaml
name: math-assistant
description: A Fibonacci number assistant

llm:
  name: default
  temperature: 0.3

prompt:
  system: |
    You are a math assistant specialized in Fibonacci numbers.
    Use the fibonacci tool to calculate Fibonacci numbers or sequences.
  inputVariables:
    - query

tools:
  - function:fibonacci

output:
  format: text
```

## Extending the System

To add new function capabilities:

1. Create a new `.function.js` file in this directory
2. Export a default object with the simple format shown above
3. Add it to your agent's tools array as `function:your-name`
4. Restart the orchestrator to load the new function

**Example new function:**

```javascript
// my-function.function.js
export default {
  name: 'my-function',
  description: 'Does something useful',
  parameters: {
    input: {
      type: 'string',
      description: 'The input to process',
    },
  },
  execute: async ({ input }) => {
    // Your logic here
    return `Processed: ${input}`;
  },
};
```
