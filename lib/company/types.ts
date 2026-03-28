import { z } from 'zod';

// --- Enums ---

export const CompanyStatus = z.enum(['active', 'archived']);
export const TicketStatus = z.enum(['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled']);
export const TicketPriority = z.enum(['low', 'medium', 'high', 'critical']);
export const ActivityType = z.enum(['comment', 'status_change', 'assignment_change', 'task_event']);
export const ActivityAuthorType = z.enum(['user', 'agent', 'system']);
export const RoutineStatus = z.enum(['active', 'paused']);
export const RoutineRunStatus = z.enum(['triggered', 'completed', 'failed']);

// --- Company ---

export const CompanySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  status: CompanyStatus,
  issuePrefix: z.string(),
  issueCounter: z.number().int(),
  brandColor: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Company = z.infer<typeof CompanySchema>;

export const CreateCompanySchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(1000).default(''),
  issuePrefix: z.string().min(1).max(10).regex(/^[A-Z0-9]+$/, 'Prefix must be uppercase alphanumeric'),
  brandColor: z.string().max(20).default(''),
});
export type CreateCompanyInput = z.infer<typeof CreateCompanySchema>;

export const UpdateCompanySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(1000).optional(),
  brandColor: z.string().max(20).optional(),
  status: CompanyStatus.optional(),
});
export type UpdateCompanyInput = z.infer<typeof UpdateCompanySchema>;

// --- Ticket ---

export const TicketSchema = z.object({
  id: z.string(),
  companyId: z.string(),
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
  companyId: z.string(),
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

// --- Agent Context (for system prompt injection) ---

export interface AgentCompanyContext {
  company: { id: string; name: string; description: string; prefix: string };
  ticket?: { identifier: string; title: string; priority: string; description: string };
}

// --- Filter types ---

export interface TicketFilters {
  status?: string;
  priority?: string;
  assigneeAgent?: string;
}
