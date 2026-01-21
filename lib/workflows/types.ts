import { z } from 'zod';

export const InputMappingSchema = z.union([
  z.string(),
  z.object({
    from: z.enum(['context', 'step', 'vector', 'mcp']),
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

export const WorkflowDefinitionSchema = z.object({
  name: z.string().describe('Unique workflow identifier'),
  description: z.string().describe('Human-readable description'),
  version: z.string().default('1.0.0'),
  input: z.object({
    schema: z.record(InputFieldSchema),
  }),
  steps: z.array(z.union([WorkflowStepSchema, ParallelStepsSchema])),
  config: WorkflowConfigSchema.optional(),
  output: z.record(z.string()),
  metadata: z.record(z.unknown()).optional(),
});

export type InputMapping = z.infer<typeof InputMappingSchema>;
export type RetryConfig = z.infer<typeof RetryConfigSchema>;
export type StepOutput = z.infer<typeof StepOutputSchema>;
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;
export type ParallelSteps = z.infer<typeof ParallelStepsSchema>;
export type InputField = z.infer<typeof InputFieldSchema>;
export type WorkflowConfig = z.infer<typeof WorkflowConfigSchema>;
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
  type: 'step_start' | 'step_complete' | 'step_error' | 'workflow_start' | 'workflow_complete' | 'workflow_error';
  stepId?: string;
  agent?: string;
  message: string;
  progress?: {
    current: number;
    total: number;
  };
  elapsed?: number;
  error?: string;
}
