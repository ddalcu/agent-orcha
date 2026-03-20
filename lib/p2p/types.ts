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
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

// --- P2P Agent Info (what peers share about their agents) ---

export interface P2PAgentInfo {
  name: string;
  description: string;
  inputVariables: string[];
  sampleQuestions?: string[];
}

// --- P2P LLM Info (what peers share about their LLMs) ---

export interface P2PLLMInfo {
  name: string;
  provider: string;
  model: string;
}

// --- Protocol Messages ---

export const P2PMessageTypes = [
  'handshake',
  'catalog',
  'invoke',
  'stream',
  'stream_end',
  'stream_error',
  'llm_invoke',
  'llm_stream',
  'llm_stream_end',
  'llm_stream_error',
] as const;

export type P2PMessageType = typeof P2PMessageTypes[number];

export interface HandshakeMessage {
  type: 'handshake';
  peerId: string;
  peerName: string;
  version: string;
  agents: P2PAgentInfo[];
  llms?: P2PLLMInfo[];
}

export interface CatalogMessage {
  type: 'catalog';
  peerName?: string;
  agents: P2PAgentInfo[];
  llms?: P2PLLMInfo[];
}

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

// --- LLM P2P Messages ---

export interface LLMInvokeMessage {
  type: 'llm_invoke';
  requestId: string;
  modelName: string;
  messages: P2PWireMessage[];
  temperature?: number;
  tools?: P2PWireTool[];
}

export interface LLMStreamMessage {
  type: 'llm_stream';
  requestId: string;
  chunk:
    | { type: 'content' | 'thinking'; content: string }
    | { type: 'usage'; input_tokens: number; output_tokens: number; total_tokens: number }
    | { type: 'tool_calls'; tool_calls: ToolCall[] };
}

export interface LLMStreamEndMessage {
  type: 'llm_stream_end';
  requestId: string;
}

export interface LLMStreamErrorMessage {
  type: 'llm_stream_error';
  requestId: string;
  error: string;
}

export type P2PMessage =
  | HandshakeMessage
  | CatalogMessage
  | InvokeMessage
  | StreamMessage
  | StreamEndMessage
  | StreamErrorMessage
  | LLMInvokeMessage
  | LLMStreamMessage
  | LLMStreamEndMessage
  | LLMStreamErrorMessage;

// --- Peer tracking ---

export interface PeerInfo {
  peerId: string;
  peerName: string;
  version: string;
  agents: P2PAgentInfo[];
  llms: P2PLLMInfo[];
  connectedAt: number;
}

// --- Remote agent (aggregated view for API) ---

export interface RemoteAgent extends P2PAgentInfo {
  peerId: string;
  peerName: string;
}

// --- Remote LLM (aggregated view for API) ---

export interface RemoteLLM extends P2PLLMInfo {
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
