import { stringify } from 'yaml';

// ── Example Templates ────────────────────────────────────────────────

const agentExample = (name: string) => ({
  name,
  description: 'TODO - describe what this agent does',
  version: '1.0.0',
  llm: {
    name: 'default',
    temperature: 0.3,
  },
  prompt: {
    system: 'You are a helpful assistant.\nTODO - add your system prompt here.',
    inputVariables: ['query'],
  },
  tools: ['function:tool-name'],
  // skills: ['skill-name'],
  // output: { type: 'json', schema: {} },
  // metadata: { category: 'custom', tags: [] },
});

const workflowExample = (name: string) => ({
  name,
  description: 'TODO - describe what this workflow does',
  version: '1.0.0',
  type: 'steps',
  input: {
    schema: {
      query: {
        type: 'string',
        required: true,
        description: 'The input query',
      },
    },
  },
  steps: [
    {
      id: 'step-1',
      agent: 'TODO-agent-name',
      input: { query: '{{input.query}}' },
      output: { key: 'result' },
      // condition: '...',
      // retry: { maxAttempts: 3, delay: 1000 },
    },
  ],
  output: {
    result: '{{steps.step-1.output}}',
  },
  // config: { timeout: 30000, continueOnError: false },
  // metadata: { category: 'custom', tags: [] },
});

const knowledgeExample = (name: string) => ({
  name,
  description: 'TODO - describe this knowledge store',
  source: {
    type: 'directory',
    path: 'knowledge/data',
    pattern: '*.txt',
  },
  loader: {
    type: 'text',
  },
  splitter: {
    type: 'recursive',
    chunkSize: 1000,
    chunkOverlap: 200,
  },
  embedding: 'default',
  store: {
    type: 'memory',
  },
  // search: { topK: 5, scoreThreshold: 0.7 },
  // metadata: { category: 'custom', tags: [] },
});

const functionTemplate = (name: string) => `\
export default {
  name: '${name}',
  description: 'TODO - describe what this function does',

  parameters: {
    input: {
      type: 'string',
      description: 'The input value',
    },
  },

  execute: async ({ input }) => {
    // TODO - implement your function logic
    return input;
  },
};
`;

const skillTemplate = (name: string) => `\
---
name: ${name}
description: TODO - describe what this skill does
sandbox: false  # set to true to auto-inject sandbox_exec tool
---

# ${name}

TODO - write skill instructions here.

These instructions are injected into the agent's system prompt
when this skill is attached.

## Usage

Describe how to use this skill, including any commands,
APIs, or tools the agent should invoke.
`;

// ── Resource Registry ────────────────────────────────────────────────

const resources: Record<string, {
  path: (name: string) => string;
  content: (name: string) => string;
}> = {
  agent: {
    path: (name) => `agents/${name}.agent.yaml`,
    content: (name) => stringify(agentExample(name)),
  },
  workflow: {
    path: (name) => `workflows/${name}.workflow.yaml`,
    content: (name) => stringify(workflowExample(name)),
  },
  knowledge: {
    path: (name) => `knowledge/${name}.knowledge.yaml`,
    content: (name) => stringify(knowledgeExample(name)),
  },
  function: {
    path: (name) => `functions/${name}.function.js`,
    content: functionTemplate,
  },
  skill: {
    path: (name) => `skills/${name}/SKILL.md`,
    content: skillTemplate,
  },
};

// ── Public API ───────────────────────────────────────────────────────

export function getResourceTypes(): string[] {
  return Object.keys(resources);
}

export function generateResourceTemplate(type: string, name: string): { path: string; content: string } | null {
  const resource = resources[type];
  if (!resource) return null;
  return {
    path: resource.path(name),
    content: resource.content(name),
  };
}
