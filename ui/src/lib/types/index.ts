export interface Agent {
  name: string;
  description?: string;
  icon?: string;
  model?: string;
  tools?: (string | { name: string })[];
  inputVariables?: string[];
  sampleQuestions?: string[];
  publish?: { enabled: boolean; password?: string } | boolean;
  p2p?: { share: boolean; leverage: false | string };
  memory?: boolean | { enabled: boolean };
}

export interface Workflow {
  name: string;
  description?: string;
  type?: string;
  chatOutputFormat?: string;
  inputSchema?: Record<string, unknown>;
  sampleQuestions?: string[];
  agents?: string[];
  tools?: string[];
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
  toolCallId?: string;
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

export type TabId = 'agents' | 'knowledge' | 'graph' | 'tools' | 'monitor' | 'llm' | 'ide' | 'p2p' | 'organizations' | 'tickets' | 'routines' | 'orgchart' | 'dashboard';

export interface Organization {
  id: string;
  name: string;
  description: string;
  status: string;
  issuePrefix: string;
  issueCounter: number;
  brandColor: string;
  ceoType: string;
  ceoConfig: string;
  createdAt: string;
  updatedAt: string;
}

export interface Ticket {
  id: string;
  orgId: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  assigneeAgent: string;
  issueNumber: number;
  identifier: string;
  taskId: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string;
  activity?: TicketActivity[];
}

export interface TicketActivity {
  id: string;
  ticketId: string;
  type: string;
  content: string;
  authorType: string;
  authorName: string;
  oldValue: string;
  newValue: string;
  metadata: string;
  createdAt: string;
}

export interface Routine {
  id: string;
  orgId: string;
  name: string;
  description: string;
  schedule: string;
  timezone: string;
  agentName: string;
  agentInput: string;
  status: string;
  lastTriggeredAt: string;
  nextRunAt: string;
  createdAt: string;
  updatedAt: string;
  runs?: RoutineRun[];
}

export interface RoutineRun {
  id: string;
  routineId: string;
  taskId: string;
  status: string;
  triggeredAt: string;
  completedAt: string;
  error: string;
  createdAt: string;
}

export interface OrgMember {
  id: string;
  orgId: string;
  agentName: string;
  title: string;
  role: string;
  reportsTo: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface OrgMemberNode extends OrgMember {
  children: OrgMemberNode[];
}

export interface P2PStatus {
  enabled: boolean;
  connected: boolean;
  peerCount: number;
  peerName: string;
  networkKey: string;
  rateLimit: number;
  disabledByEnv?: boolean;
}

export interface P2PPeer {
  peerId: string;
  peerName: string;
  version: string;
  agents: P2PRemoteAgent[];
  connectedAt: number;
}

export interface P2PRemoteAgent {
  name: string;
  description: string;
  inputVariables: string[];
  sampleQuestions?: string[];
  peerId: string;
  peerName: string;
}

export interface P2PRemoteModel {
  name: string;
  provider: string;
  model: string;
  type?: string;       // 'chat' | 'image' | 'tts'
  peerId: string;
  peerName: string;
  capabilities?: string[];
}

export interface P2PTokenBreakdown {
  name: string;
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
}

export interface P2PDirectionStats {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalRequests: number;
  byModel: P2PTokenBreakdown[];
  byAgent: P2PTokenBreakdown[];
}

export interface P2PNetworkStats {
  networkKey: string;
  served: P2PDirectionStats;
  consumed: P2PDirectionStats;
  lastUpdated: number;
}

export interface P2PLeaderboardEntry {
  peerId: string;
  peerName: string;
  servedInputTokens: number;
  servedOutputTokens: number;
  servedTotalTokens: number;
  servedRequests: number;
  consumedInputTokens: number;
  consumedOutputTokens: number;
  consumedTotalTokens: number;
  consumedRequests: number;
  online: boolean;
  lastUpdated: number;
  isSelf: boolean;
}

export interface CEORun {
  id: string;
  orgId: string;
  taskId: string;
  type: string;
  status: string;
  triggerSource: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  summary: string;
  decisions: string;
  ticketsCreated: string;
  ticketsUpdated: string;
  sessionId: string;
  error: string;
  startedAt: string;
  completedAt: string;
  createdAt: string;
}

export interface HeartbeatConfig {
  orgId: string;
  enabled: number;
  schedule: string;
  timezone: string;
  contextSnapshot: string;
  updatedAt: string;
}

export interface OrgDashboard {
  ceo: {
    configured: boolean;
    type: string;
    agentName?: string;
    status: 'idle' | 'working';
    lastRunAt?: string;
    lastRunSummary?: string;
    heartbeatEnabled: boolean;
    heartbeatSchedule?: string;
  };
  runs: CEORun[];
  runStats: {
    totalRuns: number;
    totalCost: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    avgDurationMs: number;
    last24hRuns: number;
    last7dCost: number;
  };
  tickets: {
    total: number;
    byStatus: Record<string, number>;
    recentlyUpdated: Ticket[];
  };
  agents: {
    total: number;
    members: { agentName: string; role: string; title: string }[];
  };
  taskStats: {
    totalTasks: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    byAgent: { name: string; count: number; inputTokens: number; outputTokens: number }[];
  };
}
