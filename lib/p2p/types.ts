import type { ToolCall } from '../types/llm-types.ts';

// --- P2P Wire Tool Schema (JSON Schema representation of a tool) ---

export interface P2PWireTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

// --- P2P Wire Message (richer message format for tool-calling) ---

export interface P2PWireMessage {
  role: string;
  content: string | P2PWireContentPart[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export type P2PWireContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mediaType: string };

// --- P2P Agent Info (what peers share about their agents) ---

export interface P2PAgentInfo {
  name: string;
  description: string;
  inputVariables: string[];
  sampleQuestions?: string[];
}

// --- P2P Model Info (what peers share about their models) ---

export type P2PModelType = 'chat' | 'image' | 'tts';

export interface P2PModelInfo {
  name: string;           // config key on host
  model: string;          // model string (display / description)
  type: P2PModelType;     // what kind of model
  modelId?: string;       // actual model file/identifier (e.g. "flux-2-klein-4b-Q4_K_M.gguf", "qwen3.5-4b")
  capabilities?: string[];
}

// --- Protocol Messages ---

export const P2PMessageTypes = [
  'handshake',
  'catalog',
  'invoke',
  'stream',
  'stream_end',
  'stream_error',
  'model_task_invoke',
  'model_task_result',
  'model_task_stream',
  'model_task_stream_end',
  'model_task_error',
  'leaderboard_request',
  'leaderboard_response',
] as const;

export type P2PMessageType = typeof P2PMessageTypes[number];

export interface HandshakeMessage {
  type: 'handshake';
  peerId: string;
  peerName: string;
  version: string;
  agents: P2PAgentInfo[];
  models?: P2PModelInfo[];
}

export interface CatalogMessage {
  type: 'catalog';
  peerName?: string;
  agents: P2PAgentInfo[];
  models?: P2PModelInfo[];
  load?: number;
  /** Inline token stats for real-time leaderboard (served/consumed input/output totals) */
  stats?: { si: number; so: number; ci: number; co: number };
}

// --- Agent Invoke Messages ---

export interface InvokeMessage {
  type: 'invoke';
  requestId: string;
  agentName: string;
  input: Record<string, unknown>;
  sessionId: string;
}

export interface StreamMessage {
  type: 'stream';
  requestId: string;
  chunk: unknown;
}

export interface StreamEndMessage {
  type: 'stream_end';
  requestId: string;
}

export interface StreamErrorMessage {
  type: 'stream_error';
  requestId: string;
  error: string;
}

// --- Unified Model Task Messages ---

export interface ModelTaskInvokeMessage {
  type: 'model_task_invoke';
  requestId: string;
  taskType: 'chat' | 'image' | 'tts' | 'video_frame';
  modelName: string;
  params: Record<string, unknown>;
}

export interface ModelTaskResultMessage {
  type: 'model_task_result';
  requestId: string;
  data: string;  // base64 encoded result
  metadata?: Record<string, unknown>;
}

export interface ModelTaskStreamMessage {
  type: 'model_task_stream';
  requestId: string;
  chunk:
    | { type: 'content' | 'thinking'; content: string }
    | { type: 'usage'; input_tokens: number; output_tokens: number; total_tokens: number }
    | { type: 'tool_calls'; tool_calls: ToolCall[] };
}

export interface ModelTaskStreamEndMessage {
  type: 'model_task_stream_end';
  requestId: string;
}

export interface ModelTaskErrorMessage {
  type: 'model_task_error';
  requestId: string;
  error: string;
}

// --- Leaderboard Messages ---

export interface LeaderboardRequestMessage {
  type: 'leaderboard_request';
  requestId: string;
}

export interface LeaderboardResponseMessage {
  type: 'leaderboard_response';
  requestId: string;
  entries: P2PLeaderboardEntry[];
}

// --- Video Settings (used by video tool, not a P2P message) ---

export interface VideoSettings {
  totalFrames: number;
  width: number;
  height: number;
  cfgScale: number;
  steps: number;
  seed?: number;
  fps: number;
}

// --- P2P Message Union ---

export type P2PMessage =
  | HandshakeMessage
  | CatalogMessage
  | InvokeMessage
  | StreamMessage
  | StreamEndMessage
  | StreamErrorMessage
  | ModelTaskInvokeMessage
  | ModelTaskResultMessage
  | ModelTaskStreamMessage
  | ModelTaskStreamEndMessage
  | ModelTaskErrorMessage
  | LeaderboardRequestMessage
  | LeaderboardResponseMessage;

// --- Peer tracking ---

export interface PeerInfo {
  peerId: string;
  peerName: string;
  version: string;
  agents: P2PAgentInfo[];
  models: P2PModelInfo[];
  load: number;
  connectedAt: number;
}

// --- Remote agent (aggregated view for API) ---

export interface RemoteAgent extends P2PAgentInfo {
  peerId: string;
  peerName: string;
}

// --- Remote model (aggregated view for API) ---

export interface RemoteModel extends P2PModelInfo {
  peerId: string;
  peerName: string;
}

// --- P2P Status ---

export interface P2PStatus {
  enabled: boolean;
  connected: boolean;
  peerCount: number;
  peerName: string;
  networkKey: string;
  rateLimit: number;
}

// --- Token Tracking ---

export interface P2PTokenBreakdown {
  name: string;          // model config key or agent name
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

/** Compact DHT payload — single-char keys to stay under 1KB */
export interface P2PDHTStats {
  v: 1;                  // schema version
  n: string;             // peer name
  s: { i: number; o: number; r: number };  // served: input, output, requests
  c: { i: number; o: number; r: number };  // consumed: input, output, requests
  t: number;             // epoch seconds
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
