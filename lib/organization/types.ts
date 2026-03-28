import { z } from 'zod';

// --- Enums ---

export const OrgStatus = z.enum(['active', 'archived']);
export const TicketStatus = z.enum(['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled']);
export const TicketPriority = z.enum(['low', 'medium', 'high', 'critical']);
export const ActivityType = z.enum(['comment', 'status_change', 'assignment_change', 'task_event']);
export const ActivityAuthorType = z.enum(['user', 'agent', 'system']);
export const RoutineStatus = z.enum(['active', 'paused']);
export const RoutineRunStatus = z.enum(['triggered', 'completed', 'failed']);
export const OrgMemberRole = z.enum(['ceo', 'manager', 'member']);
export const CEOType = z.enum(['', 'agent', 'claude-code']);

// --- Organization ---

export const OrganizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  status: OrgStatus,
  issuePrefix: z.string(),
  issueCounter: z.number().int(),
  brandColor: z.string(),
  ceoType: CEOType,
  ceoConfig: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Organization = z.infer<typeof OrganizationSchema>;

export const CreateOrgSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(1000).default(''),
  issuePrefix: z.string().min(1).max(10).regex(/^[A-Z0-9]+$/, 'Prefix must be uppercase alphanumeric'),
  brandColor: z.string().max(20).default(''),
});
export type CreateOrgInput = z.infer<typeof CreateOrgSchema>;

export const UpdateOrgSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(1000).optional(),
  brandColor: z.string().max(20).optional(),
  status: OrgStatus.optional(),
  ceoType: CEOType.optional(),
  ceoConfig: z.string().optional(),
});
export type UpdateOrgInput = z.infer<typeof UpdateOrgSchema>;

// --- Ticket ---

export const TicketSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  title: z.string(),
  description: z.string(),
  status: TicketStatus,
  priority: TicketPriority,
  assigneeAgent: z.string(),
  issueNumber: z.number().int(),
  identifier: z.string(),
  taskId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string(),
});
export type Ticket = z.infer<typeof TicketSchema>;

export const CreateTicketSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(10000).default(''),
  priority: TicketPriority.default('medium'),
  assigneeAgent: z.string().default(''),
});
export type CreateTicketInput = z.infer<typeof CreateTicketSchema>;

export const UpdateTicketSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(10000).optional(),
  priority: TicketPriority.optional(),
  assigneeAgent: z.string().optional(),
});
export type UpdateTicketInput = z.infer<typeof UpdateTicketSchema>;

// --- Ticket Activity ---

export const TicketActivitySchema = z.object({
  id: z.string(),
  ticketId: z.string(),
  type: ActivityType,
  content: z.string(),
  authorType: ActivityAuthorType,
  authorName: z.string(),
  oldValue: z.string(),
  newValue: z.string(),
  metadata: z.string(),
  createdAt: z.string(),
});
export type TicketActivity = z.infer<typeof TicketActivitySchema>;

// --- Routine ---

export const RoutineSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  description: z.string(),
  schedule: z.string(),
  timezone: z.string(),
  agentName: z.string(),
  agentInput: z.string(),
  status: RoutineStatus,
  lastTriggeredAt: z.string(),
  nextRunAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Routine = z.infer<typeof RoutineSchema>;

export const CreateRoutineSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(''),
  schedule: z.string().min(1),
  timezone: z.string().default('UTC'),
  agentName: z.string().min(1),
  agentInput: z.record(z.unknown()).default({}),
});
export type CreateRoutineInput = z.infer<typeof CreateRoutineSchema>;

export const UpdateRoutineSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  schedule: z.string().min(1).optional(),
  timezone: z.string().optional(),
  agentName: z.string().min(1).optional(),
  agentInput: z.record(z.unknown()).optional(),
});
export type UpdateRoutineInput = z.infer<typeof UpdateRoutineSchema>;

// --- Routine Run ---

export const RoutineRunSchema = z.object({
  id: z.string(),
  routineId: z.string(),
  taskId: z.string(),
  status: RoutineRunStatus,
  triggeredAt: z.string(),
  completedAt: z.string(),
  error: z.string(),
  createdAt: z.string(),
});
export type RoutineRun = z.infer<typeof RoutineRunSchema>;

// --- Org Chart Member ---

export const OrgMemberSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  agentName: z.string(),
  title: z.string(),
  role: OrgMemberRole,
  reportsTo: z.string().nullable(),
  position: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OrgMember = z.infer<typeof OrgMemberSchema>;

export interface OrgMemberNode extends OrgMember {
  children: OrgMemberNode[];
}

export const CreateOrgMemberSchema = z.object({
  agentName: z.string().min(1),
  title: z.string().max(200).default(''),
  role: OrgMemberRole.default('member'),
  reportsTo: z.string().nullable().default(null),
  position: z.number().int().default(0),
});
export type CreateOrgMemberInput = z.infer<typeof CreateOrgMemberSchema>;

export const UpdateOrgMemberSchema = z.object({
  title: z.string().max(200).optional(),
  role: OrgMemberRole.optional(),
  reportsTo: z.string().nullable().optional(),
  position: z.number().int().optional(),
});
export type UpdateOrgMemberInput = z.infer<typeof UpdateOrgMemberSchema>;

// --- CEO Config ---

export const CEOConfigSchema = z.object({
  agentName: z.string().optional(),
  lastSessionId: z.string().optional(),
});
export type CEOConfig = z.infer<typeof CEOConfigSchema>;

// --- Agent Context (for system prompt injection) ---

export interface AgentOrgContext {
  organization: { id: string; name: string; description: string; prefix: string };
  ticket?: { identifier: string; title: string; priority: string; description: string };
  orgChart?: { agentName: string; role: string; title: string }[];
  activeTickets?: { identifier: string; title: string; status: string; priority: string; assigneeAgent: string }[];
}

// --- CEO Run ---

export const CEORunType = z.enum(['heartbeat', 'triage', 'review', 'manual']);
export const CEORunStatus = z.enum(['running', 'completed', 'failed']);

export const CEORunSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  taskId: z.string(),
  type: CEORunType,
  status: CEORunStatus,
  triggerSource: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number(),
  durationMs: z.number(),
  summary: z.string(),
  decisions: z.string(),
  ticketsCreated: z.string(),
  ticketsUpdated: z.string(),
  sessionId: z.string(),
  error: z.string(),
  startedAt: z.string(),
  completedAt: z.string(),
  createdAt: z.string(),
});
export type CEORun = z.infer<typeof CEORunSchema>;

// --- Heartbeat Config ---

export const HeartbeatConfigSchema = z.object({
  orgId: z.string(),
  enabled: z.number(),
  schedule: z.string(),
  timezone: z.string(),
  contextSnapshot: z.string(),
  updatedAt: z.string(),
});
export type HeartbeatConfig = z.infer<typeof HeartbeatConfigSchema>;

// --- Task Log (persisted to DB) ---
// TaskLogRow type is defined in task-metrics-manager.ts

// --- Dashboard ---

export interface OrgDashboard {
  ceo: {
    configured: boolean;
    type: string;
    agentName?: string;
    status: 'idle' | 'working';
    lastRunAt?: string;
    lastRunSummary?: string;
    nextScheduledAt?: string;
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

// --- Filter types ---

export interface TicketFilters {
  status?: string;
  priority?: string;
  assigneeAgent?: string;
}
