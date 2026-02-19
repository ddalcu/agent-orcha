import type { AgentResult } from '../agents/types.ts';
import type { WorkflowResult } from '../workflows/types.ts';

export type TaskStatus =
  | 'submitted'
  | 'working'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'input-required';

export type TaskKind = 'agent' | 'workflow' | 'llm';

export interface TaskInputRequest {
  question: string;
  threadId: string;
  timestamp: number;
}

export interface Task {
  id: string;
  kind: TaskKind;
  target: string;
  status: TaskStatus;
  input: Record<string, unknown>;
  sessionId?: string;
  result?: AgentResult | WorkflowResult | Record<string, unknown>;
  error?: string;
  inputRequest?: TaskInputRequest;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface TaskStoreConfig {
  maxTasks?: number;
  taskTTL?: number;
  cleanupInterval?: number;
}

export interface SubmitAgentParams {
  agent: string;
  input: Record<string, unknown>;
  sessionId?: string;
}

export interface SubmitWorkflowParams {
  workflow: string;
  input: Record<string, unknown>;
}
