import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { StructuredOutputWrapper } from '../../lib/agents/structured-output-wrapper.ts';

describe('StructuredOutputWrapper.validateOutput', () => {
  it('should validate a correct output against schema', () => {
    const schema = {
      required: ['name', 'age'],
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
    };

    const result = StructuredOutputWrapper.validateOutput({ name: 'Alice', age: 30 }, schema);
    assert.equal(result.valid, true);
  });

  it('should reject non-object output', () => {
    const schema = { properties: {} };

    assert.equal(StructuredOutputWrapper.validateOutput('string', schema).valid, false);
    assert.equal(StructuredOutputWrapper.validateOutput(null, schema).valid, false);
    assert.equal(StructuredOutputWrapper.validateOutput(42, schema).valid, false);
  });

  it('should detect missing required fields', () => {
    const schema = {
      required: ['name', 'age'],
      properties: { name: { type: 'string' }, age: { type: 'number' } },
    };

    const result = StructuredOutputWrapper.validateOutput({ name: 'Alice' }, schema);
    assert.equal(result.valid, false);
    assert.ok(result.error!.includes('age'));
  });

  it('should validate string type', () => {
    const schema = { properties: { name: { type: 'string' } } };

    assert.equal(StructuredOutputWrapper.validateOutput({ name: 'Alice' }, schema).valid, true);
    assert.equal(StructuredOutputWrapper.validateOutput({ name: 123 }, schema).valid, false);
  });

  it('should validate number type', () => {
    const schema = { properties: { count: { type: 'number' } } };

    assert.equal(StructuredOutputWrapper.validateOutput({ count: 5 }, schema).valid, true);
    assert.equal(StructuredOutputWrapper.validateOutput({ count: 'five' }, schema).valid, false);
  });

  it('should validate boolean type', () => {
    const schema = { properties: { active: { type: 'boolean' } } };

    assert.equal(StructuredOutputWrapper.validateOutput({ active: true }, schema).valid, true);
    assert.equal(StructuredOutputWrapper.validateOutput({ active: 'yes' }, schema).valid, false);
  });

  it('should validate array type', () => {
    const schema = { properties: { items: { type: 'array' } } };

    assert.equal(StructuredOutputWrapper.validateOutput({ items: [1, 2] }, schema).valid, true);
    assert.equal(StructuredOutputWrapper.validateOutput({ items: 'not-array' }, schema).valid, false);
  });

  it('should validate object type', () => {
    const schema = { properties: { config: { type: 'object' } } };

    assert.equal(StructuredOutputWrapper.validateOutput({ config: {} }, schema).valid, true);
    assert.equal(StructuredOutputWrapper.validateOutput({ config: null }, schema).valid, false);
    assert.equal(StructuredOutputWrapper.validateOutput({ config: 'str' }, schema).valid, false);
  });

  it('should accept output with extra fields not in schema', () => {
    const schema = { properties: { name: { type: 'string' } } };

    const result = StructuredOutputWrapper.validateOutput({ name: 'Alice', extra: true }, schema);
    assert.equal(result.valid, true);
  });

  it('should accept empty schema', () => {
    const result = StructuredOutputWrapper.validateOutput({ anything: true }, {});
    assert.equal(result.valid, true);
  });
});

describe('StructuredOutputWrapper.wrapLLM', () => {
  const mockLLM = {
    withStructuredOutput: (schema: any) => ({ wrapped: true, schema }),
  } as any;

  it('should return original LLM when no output config', () => {
    const result = StructuredOutputWrapper.wrapLLM(mockLLM);
    assert.equal(result, mockLLM);
  });

  it('should return original LLM when format is not structured', () => {
    const result = StructuredOutputWrapper.wrapLLM(mockLLM, { format: 'text' });
    assert.equal(result, mockLLM);
  });

  it('should return original LLM when structured but no schema', () => {
    const result = StructuredOutputWrapper.wrapLLM(mockLLM, { format: 'structured' });
    assert.equal(result, mockLLM);
  });

  it('should wrap LLM when structured with schema', () => {
    const schema = { type: 'object', properties: { name: { type: 'string' } } };
    const result = StructuredOutputWrapper.wrapLLM(mockLLM, { format: 'structured', schema });
    assert.notEqual(result, mockLLM);
  });

  it('should return original LLM when withStructuredOutput throws', () => {
    const badLLM = {
      withStructuredOutput: () => { throw new Error('not supported'); },
    } as any;

    const schema = { type: 'object' };
    const result = StructuredOutputWrapper.wrapLLM(badLLM, { format: 'structured', schema });
    assert.equal(result, badLLM);
  });
});
