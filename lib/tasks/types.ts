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

export interface TaskMetrics {
  iteration: number;
  messageCount: number;
  imageCount: number;
  contextChars: number;
  inputTokens: number;
  outputTokens: number;
}

export interface TaskEvent {
  type: 'tool_start' | 'tool_end' | 'thinking' | 'content';
  timestamp: number;
  tool?: string;
  input?: unknown;
  output?: unknown;
  content?: string;
}

export interface TaskP2PMeta {
  direction: 'incoming' | 'outgoing';
  peerId: string;
  peerName: string;
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
  metrics?: TaskMetrics;
  events?: TaskEvent[];
  p2p?: TaskP2PMeta;
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
