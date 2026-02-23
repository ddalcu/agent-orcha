import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { getResourceTypes, generateResourceTemplate } from '../../lib/templates/resource-templates.ts';

describe('getResourceTypes', () => {
  it('should return all resource types', () => {
    const types = getResourceTypes();
    assert.ok(types.includes('agent'));
    assert.ok(types.includes('workflow'));
    assert.ok(types.includes('knowledge'));
    assert.ok(types.includes('function'));
    assert.ok(types.includes('skill'));
    assert.equal(types.length, 5);
  });
});

describe('generateResourceTemplate', () => {
  it('should generate agent template', () => {
    const result = generateResourceTemplate('agent', 'my-agent');
    assert.ok(result);
    assert.equal(result.path, 'agents/my-agent.agent.yaml');
    assert.ok(result.content.includes('my-agent'));
    assert.ok(result.content.includes('description'));
  });

  it('should generate workflow template', () => {
    const result = generateResourceTemplate('workflow', 'my-workflow');
    assert.ok(result);
    assert.equal(result.path, 'workflows/my-workflow.workflow.yaml');
    assert.ok(result.content.includes('my-workflow'));
  });

  it('should generate knowledge template', () => {
    const result = generateResourceTemplate('knowledge', 'my-kb');
    assert.ok(result);
    assert.equal(result.path, 'knowledge/my-kb.knowledge.yaml');
    assert.ok(result.content.includes('my-kb'));
  });

  it('should generate function template', () => {
    const result = generateResourceTemplate('function', 'my-func');
    assert.ok(result);
    assert.equal(result.path, 'functions/my-func.function.js');
    assert.ok(result.content.includes('my-func'));
    assert.ok(result.content.includes('execute'));
  });

  it('should generate skill template', () => {
    const result = generateResourceTemplate('skill', 'my-skill');
    assert.ok(result);
    assert.equal(result.path, 'skills/my-skill/SKILL.md');
    assert.ok(result.content.includes('my-skill'));
  });

  it('should return null for unknown type', () => {
    const result = generateResourceTemplate('unknown', 'test');
    assert.equal(result, null);
  });
});
