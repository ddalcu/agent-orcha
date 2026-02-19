import { z } from 'zod';

export const InputMappingSchema = z.union([
  z.string(),
  z.object({
    from: z.enum(['context', 'step', 'knowledge', 'mcp']),
    path: z.string(),
    transform: z.string().optional(),
  }),
]);

export const RetryConfigSchema = z.object({
  maxAttempts: z.number().default(3),
  delay: z.number().default(1000),
});

export const StepOutputSchema = z.object({
  key: z.string(),
  extract: z.string().optional(),
});

export const WorkflowStepSchema = z.object({
  id: z.string().describe('Unique step identifier'),
  agent: z.string().describe('Reference to agent name'),
  input: z.record(InputMappingSchema),
  condition: z.string().optional(),
  retry: RetryConfigSchema.optional(),
  output: StepOutputSchema.optional(),
});

export const ParallelStepsSchema = z.object({
  parallel: z.array(WorkflowStepSchema),
});

export const InputFieldSchema = z.object({
  type: z.enum(['string', 'number', 'boolean', 'array', 'object']),
  required: z.boolean().default(false),
  default: z.unknown().optional(),
  description: z.string().optional(),
});

export const WorkflowConfigSchema = z.object({
  timeout: z.number().default(300000),
  onError: z.enum(['stop', 'continue', 'retry']).default('stop'),
});

// ReAct workflow schemas
export const GraphToolConfigSchema = z.object({
  mode: z.enum(['all', 'include', 'exclude', 'none']).default('all'),
  sources: z
    .array(z.enum(['mcp', 'knowledge', 'function', 'builtin']))
    .default(['mcp', 'knowledge', 'function', 'builtin']),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
});

export const GraphAgentConfigSchema = z.object({
  mode: z.enum(['all', 'include', 'exclude', 'none']).default('all'),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
});

export const GraphConfigSchema = z.object({
  model: z.string().default('default'),
  tools: GraphToolConfigSchema.default({ mode: 'all' }),
  agents: GraphAgentConfigSchema.default({ mode: 'all' }),
  executionMode: z
    .enum(['react', 'single-turn'])
    .default('react')
    .describe(
      'Execution mode: "react" allows multiple tool call iterations (ReAct loop), "single-turn" calls tools once and returns'
    ),
  maxIterations: z.number().default(10),
  timeout: z.number().default(300000),
});

export const ReactWorkflowSchema = z.object({
  name: z.string().describe('Unique workflow identifier'),
  description: z.string().describe('Human-readable description'),
  version: z.string().default('1.0.0'),
  type: z.literal('react'),
  input: z.object({
    schema: z.record(InputFieldSchema),
  }),
  prompt: z.object({
    system: z.string(),
    goal: z.string(),
  }),
  graph: GraphConfigSchema,
  output: z.record(z.string()),
  config: WorkflowConfigSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
});

// Step-based workflow (existing)
export const StepBasedWorkflowSchema = z.object({
  name: z.string().describe('Unique workflow identifier'),
  description: z.string().describe('Human-readable description'),
  version: z.string().default('1.0.0'),
  type: z.literal('steps').default('steps'),
  input: z.object({
    schema: z.record(InputFieldSchema),
  }),
  steps: z.array(z.union([WorkflowStepSchema, ParallelStepsSchema])),
  config: WorkflowConfigSchema.optional(),
  output: z.record(z.string()),
  metadata: z.record(z.unknown()).optional(),
});

// Discriminated union of workflow types
export const WorkflowDefinitionSchema = z.discriminatedUnion('type', [
  StepBasedWorkflowSchema,
  ReactWorkflowSchema,
]);

export type InputMapping = z.infer<typeof InputMappingSchema>;
export type RetryConfig = z.infer<typeof RetryConfigSchema>;
export type StepOutput = z.infer<typeof StepOutputSchema>;
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;
export type ParallelSteps = z.infer<typeof ParallelStepsSchema>;
export type InputField = z.infer<typeof InputFieldSchema>;
export type WorkflowConfig = z.infer<typeof WorkflowConfigSchema>;
export type GraphToolConfig = z.infer<typeof GraphToolConfigSchema>;
export type GraphAgentConfig = z.infer<typeof GraphAgentConfigSchema>;
export type GraphConfig = z.infer<typeof GraphConfigSchema>;
export type ReactWorkflowDefinition = z.infer<typeof ReactWorkflowSchema>;
export type StepBasedWorkflowDefinition = z.infer<typeof StepBasedWorkflowSchema>;
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

export interface StepResult {
  output: unknown;
  metadata: {
    duration: number;
    agent: string;
    success: boolean;
    error?: string;
  };
}

export interface WorkflowContext {
  input: Record<string, unknown>;
  steps: Record<string, StepResult>;
  vectors: Record<string, unknown[]>;
}

export interface WorkflowResult {
  output: Record<string, unknown>;
  metadata: {
    duration: number;
    stepsExecuted: number;
    success: boolean;
  };
  stepResults: Record<string, StepResult>;
}

export interface WorkflowStatus {
  type:
    | 'step_start'
    | 'step_complete'
    | 'step_error'
    | 'workflow_start'
    | 'workflow_complete'
    | 'workflow_error'
    | 'workflow_interrupt'
    | 'tool_discovery'
    | 'react_iteration'
    | 'tool_call'
    | 'tool_result';
  stepId?: string;
  agent?: string;
  message: string;
  progress?: {
    current: number;
    total: number;
  };
  elapsed?: number;
  error?: string;
  interrupt?: WorkflowInterrupt;
}

// Interrupt types for human-in-the-loop
export interface WorkflowInterrupt {
  threadId: string;
  question: string;
  timestamp: number;
}

export interface InterruptState {
  threadId: string;
  workflowName: string;
  question: string;
  timestamp: number;
  resolved: boolean;
  answer?: string;
}
