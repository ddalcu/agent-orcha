import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { AgentDefinitionSchema, ToolReferenceSchema, OutputConfigSchema, AgentMemoryConfigSchema } from '../lib/agents/types.ts';
import { WorkflowDefinitionSchema, WorkflowStepSchema, WorkflowConfigSchema, InputFieldSchema } from '../lib/workflows/types.ts';
import { KnowledgeConfigSchema, SourceConfigSchema } from '../lib/knowledge/types.ts';
import { AgentLLMRefSchema, ModelConfigSchema, LLMJsonConfigSchema } from '../lib/llm/types.ts';
import { AgentSkillsConfigSchema } from '../lib/skills/types.ts';
import { IntegrationSchema } from '../lib/integrations/types.ts';
import { TriggerSchema } from '../lib/triggers/types.ts';

describe('AgentDefinitionSchema', () => {
  it('should parse a valid agent definition', () => {
    const result = AgentDefinitionSchema.parse({
      name: 'test-agent',
      description: 'A test agent',
      prompt: { system: 'You are helpful' },
    });

    assert.equal(result.name, 'test-agent');
    assert.equal(result.version, '1.0.0');
    assert.deepEqual(result.tools, []);
  });

  it('should reject missing required fields', () => {
    assert.throws(() => AgentDefinitionSchema.parse({ name: 'test' }));
    assert.throws(() => AgentDefinitionSchema.parse({ description: 'test' }));
  });

  it('should parse with all optional fields', () => {
    const result = AgentDefinitionSchema.parse({
      name: 'full-agent',
      description: 'Full',
      version: '2.0.0',
      llm: { name: 'fast', temperature: 0.5 },
      prompt: { system: 'Prompt', inputVariables: ['query'] },
      tools: ['function:search'],
      output: { format: 'json' },
      memory: true,
      metadata: { category: 'test' },
    });

    assert.equal(result.version, '2.0.0');
    assert.deepEqual(result.prompt.inputVariables, ['query']);
  });
});

describe('ToolReferenceSchema', () => {
  it('should accept string reference', () => {
    const result = ToolReferenceSchema.parse('function:search');
    assert.equal(result, 'function:search');
  });

  it('should accept object reference', () => {
    const result = ToolReferenceSchema.parse({ name: 'search', source: 'mcp' });
    assert.deepEqual(result, { name: 'search', source: 'mcp' });
  });

  it('should reject invalid source', () => {
    assert.throws(() => ToolReferenceSchema.parse({ name: 'x', source: 'invalid' }));
  });
});

describe('OutputConfigSchema', () => {
  it('should default format to text', () => {
    const result = OutputConfigSchema.parse({});
    assert.equal(result.format, 'text');
  });

  it('should accept structured format with schema', () => {
    const result = OutputConfigSchema.parse({ format: 'structured', schema: { type: 'object' } });
    assert.equal(result.format, 'structured');
  });
});

describe('AgentMemoryConfigSchema', () => {
  it('should accept boolean', () => {
    assert.equal(AgentMemoryConfigSchema.parse(true), true);
    assert.equal(AgentMemoryConfigSchema.parse(false), false);
  });

  it('should accept object config', () => {
    const result = AgentMemoryConfigSchema.parse({ enabled: true, maxLines: 50 });
    assert.equal(result.enabled, true);
    assert.equal(result.maxLines, 50);
  });
});

describe('WorkflowDefinitionSchema', () => {
  it('should parse a step-based workflow', () => {
    const result = WorkflowDefinitionSchema.parse({
      name: 'test-wf',
      description: 'Test',
      type: 'steps',
      input: { schema: { query: { type: 'string' } } },
      steps: [{ id: 's1', agent: 'a1', input: { q: '{{input.query}}' } }],
      output: { result: '{{steps.s1.output}}' },
    });

    assert.equal(result.type, 'steps');
    assert.equal(result.name, 'test-wf');
  });

  it('should parse a react workflow', () => {
    const result = WorkflowDefinitionSchema.parse({
      name: 'graph-wf',
      description: 'Graph',
      type: 'react',
      input: { schema: { query: { type: 'string' } } },
      prompt: { system: 'You are helpful', goal: 'Answer the query' },
      graph: {},
      output: { result: '{{output}}' },
    });

    assert.equal(result.type, 'react');
  });

  it('should reject unknown workflow type', () => {
    assert.throws(() => WorkflowDefinitionSchema.parse({
      name: 'bad',
      description: 'Bad',
      type: 'unknown',
      input: { schema: {} },
      steps: [],
      output: {},
    }));
  });
});

describe('WorkflowConfigSchema', () => {
  it('should provide defaults', () => {
    const result = WorkflowConfigSchema.parse({});
    assert.equal(result.timeout, 300000);
    assert.equal(result.onError, 'stop');
  });
});

describe('InputFieldSchema', () => {
  it('should parse valid input field', () => {
    const result = InputFieldSchema.parse({ type: 'string', description: 'A query' });
    assert.equal(result.type, 'string');
    assert.equal(result.required, false);
  });
});

describe('AgentLLMRefSchema', () => {
  it('should accept string', () => {
    assert.equal(AgentLLMRefSchema.parse('default'), 'default');
  });

  it('should accept object with name and temperature', () => {
    const result = AgentLLMRefSchema.parse({ name: 'fast', temperature: 0.5 });
    assert.deepEqual(result, { name: 'fast', temperature: 0.5 });
  });
});

describe('ModelConfigSchema', () => {
  it('should parse minimal config', () => {
    const result = ModelConfigSchema.parse({ model: 'gpt-4o' });
    assert.equal(result.model, 'gpt-4o');
  });

  it('should reject temperature out of range', () => {
    assert.throws(() => ModelConfigSchema.parse({ model: 'gpt-4', temperature: 3 }));
  });
});

describe('LLMJsonConfigSchema', () => {
  it('should parse valid config', () => {
    const result = LLMJsonConfigSchema.parse({
      models: { default: { model: 'gpt-4o' } },
      embeddings: { default: { model: 'text-embedding-3-small' } },
    });

    assert.ok(result.models['default']);
    assert.ok(result.embeddings['default']);
    assert.equal(result.version, '1.0');
  });
});

describe('KnowledgeConfigSchema', () => {
  it('should parse config without graph (chunks-only)', () => {
    const result = KnowledgeConfigSchema.parse({
      name: 'test-kb',
      description: 'Test',
      source: { type: 'directory', path: './data' },
      loader: { type: 'text' },
      splitter: { type: 'recursive' },
      embedding: 'default',
      store: { type: 'memory' },
    });

    assert.equal(result.name, 'test-kb');
    assert.equal((result as any).kind, undefined); // kind is stripped by preprocess
    assert.equal((result as any).store, undefined); // store is stripped by preprocess
    assert.equal(result.graph, undefined);
  });

  it('should parse config with graph and strip old fields', () => {
    const result = KnowledgeConfigSchema.parse({
      kind: 'graph-rag',
      name: 'graph-kb',
      description: 'Graph',
      source: { type: 'directory', path: './data' },
      loader: { type: 'text' },
      splitter: { type: 'recursive' },
      embedding: 'default',
      graph: {},
    });

    assert.equal(result.name, 'graph-kb');
    assert.equal((result as any).kind, undefined); // kind is stripped by preprocess
    assert.ok(result.graph !== undefined);
  });
});

describe('SourceConfigSchema', () => {
  it('should parse directory source', () => {
    const result = SourceConfigSchema.parse({ type: 'directory', path: './docs' });
    assert.equal(result.type, 'directory');
  });

  it('should parse file source', () => {
    const result = SourceConfigSchema.parse({ type: 'file', path: './data.txt' });
    assert.equal(result.type, 'file');
  });

  it('should parse database source', () => {
    const result = SourceConfigSchema.parse({
      type: 'database',
      connectionString: 'postgresql://localhost/db',
      query: 'SELECT * FROM docs',
    });
    assert.equal(result.type, 'database');
  });

  it('should reject invalid source type', () => {
    assert.throws(() => SourceConfigSchema.parse({ type: 'invalid' }));
  });
});

describe('AgentSkillsConfigSchema', () => {
  it('should accept mode:all', () => {
    const result = AgentSkillsConfigSchema.parse({ mode: 'all' });
    assert.deepEqual(result, { mode: 'all' });
  });

  it('should accept string array', () => {
    const result = AgentSkillsConfigSchema.parse(['skill1', 'skill2']);
    assert.deepEqual(result, ['skill1', 'skill2']);
  });
});

describe('IntegrationSchema', () => {
  it('should parse collabnook integration', () => {
    const result = IntegrationSchema.parse({
      type: 'collabnook',
      url: 'ws://localhost:3001',
      channel: 'general',
      botName: 'bot',
    });
    assert.equal(result.type, 'collabnook');
  });
});

describe('TriggerSchema', () => {
  it('should parse cron trigger', () => {
    const result = TriggerSchema.parse({ type: 'cron', schedule: '* * * * *' });
    assert.equal(result.type, 'cron');
  });

  it('should parse webhook trigger', () => {
    const result = TriggerSchema.parse({ type: 'webhook', path: '/hook' });
    assert.equal(result.type, 'webhook');
  });
});
