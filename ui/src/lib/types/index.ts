export interface Agent {
  name: string;
  description?: string;
  model?: string;
  tools?: (string | { name: string })[];
  inputVariables?: string[];
  sampleQuestions?: string[];
  publish?: { enabled: boolean; password?: string } | boolean;
  memory?: boolean | { enabled: boolean };
}

export interface Workflow {
  name: string;
  description?: string;
  type?: string;
  chatOutputFormat?: string;
  inputSchema?: Record<string, unknown>;
  sampleQuestions?: string[];
}

export interface LLM {
  name: string;
  model?: string;
  provider?: string;
}

export interface Session {
  id: string;
  agentName: string | null;
  agentType: 'agent' | 'llm' | 'workflow';
  llmName: string | null;
  workflowName: string | null;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  meta?: MessageMeta;
}

export interface MessageMeta {
  thinking?: string[];
  tools?: ToolCall[];
  stats?: StreamStats;
}

export interface ToolCall {
  runId: string;
  tool: string;
  input: unknown;
  output?: unknown;
}

export interface StreamStats {
  elapsed: number;
  inputTokens: number;
  outputTokens: number;
  cancelled: boolean;
  estimated: boolean;
}

export interface StreamEvent {
  type: string;
  content?: string;
  tool?: string;
  runId?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  message?: string;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  iteration?: number;
  contextChars?: number;
  taskId?: string;
  toolInput?: string;
  toolOutput?: string;
  stepId?: string;
  agent?: string;
  status?: string;
  data?: unknown;
}

export interface KnowledgeStore {
  name: string;
  description?: string;
  status: string;
  isIndexing?: boolean;
  source?: { type: string };
  store?: string;
  hasGraph?: boolean;
  documentCount?: number;
  chunkCount?: number;
  entityCount?: number;
  edgeCount?: number;
  communityCount?: number;
  defaultK?: number;
  embeddingModel?: string;
  lastIndexedAt?: string;
  lastIndexDurationMs?: number;
  errorMessage?: string;
}

export interface Task {
  id: string;
  target: string;
  kind: string;
  status: string;
  input: unknown;
  result?: unknown;
  error?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  events?: StreamEvent[];
  metrics?: TaskMetrics;
  inputRequest?: { question: string };
}

export interface TaskMetrics {
  iteration: number;
  messageCount: number;
  imageCount: number;
  contextChars: number;
  inputTokens?: number;
  outputTokens?: number;
}

export type TabId = 'agents' | 'knowledge' | 'graph' | 'mcp' | 'monitor' | 'llm' | 'ide';
