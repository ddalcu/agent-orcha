import { z } from 'zod';
import { tool } from '../../types/tool-factory.ts';
import type { StructuredTool } from '../../types/llm-types.ts';
import type { TicketManager } from '../../organization/ticket-manager.ts';
import type { OrgChartManager } from '../../organization/org-chart-manager.ts';
import { TicketStatus, TicketPriority, OrgMemberRole } from '../../organization/types.ts';
import { logger } from '../../logger.ts';

export interface OrgToolDeps {
  orgId: string;
  tickets: TicketManager;
  orgChart: OrgChartManager;
  submitAgent: (params: {
    agent: string;
    input: Record<string, unknown>;
    orgContext?: { organization: { id: string; name: string; description: string; prefix: string } };
    onComplete?: (result: { output: unknown }) => void;
    onError?: (error: string) => void;
  }) => { id: string };
}

export function buildOrgTools(deps: OrgToolDeps): Map<string, StructuredTool> {
  const tools = new Map<string, StructuredTool>();

  tools.set('list_tickets', tool(
    async ({ status, priority }) => {
      let tickets = deps.tickets.list(deps.orgId);
      if (status) tickets = tickets.filter(t => t.status === status);
      if (priority) tickets = tickets.filter(t => t.priority === priority);
      return JSON.stringify(tickets.map(t => ({
        id: t.id, identifier: t.identifier, title: t.title, status: t.status,
        priority: t.priority, assigneeAgent: t.assigneeAgent, description: t.description.slice(0, 200),
      })));
    },
    {
      name: 'org_list_tickets',
      description: 'List tickets in your organization. Optionally filter by status or priority.',
      schema: z.object({
        status: TicketStatus.optional().describe('Filter by status: backlog, todo, in_progress, in_review, blocked, done, cancelled'),
        priority: TicketPriority.optional().describe('Filter by priority: low, medium, high, critical'),
      }),
    },
  ));

  tools.set('get_ticket', tool(
    async ({ ticketId }) => {
      const ticket = deps.tickets.get(ticketId);
      if (!ticket) return JSON.stringify({ error: `Ticket not found: ${ticketId}` });
      const activity = deps.tickets.getActivity(ticketId);
      return JSON.stringify({ ...ticket, activity });
    },
    {
      name: 'org_get_ticket',
      description: 'Get full ticket details including activity history and comments.',
      schema: z.object({
        ticketId: z.string().describe('Ticket ID'),
      }),
    },
  ));

  tools.set('create_ticket', tool(
    async ({ title, description, priority, assigneeAgent }) => {
      const ticket = deps.tickets.create(deps.orgId, { title, description, priority, assigneeAgent });
      return JSON.stringify({ created: true, id: ticket.id, identifier: ticket.identifier });
    },
    {
      name: 'org_create_ticket',
      description: 'Create a new ticket in your organization.',
      schema: z.object({
        title: z.string().min(1).max(500).describe('Ticket title'),
        description: z.string().max(10000).default('').describe('Detailed description'),
        priority: TicketPriority.default('medium').describe('Priority: low, medium, high, critical'),
        assigneeAgent: z.string().default('').describe('Agent name to assign (leave empty for unassigned)'),
      }),
    },
  ));

  tools.set('update_ticket', tool(
    async ({ ticketId, title, description, priority, assigneeAgent }) => {
      const updates: Record<string, unknown> = {};
      if (title !== undefined) updates.title = title;
      if (description !== undefined) updates.description = description;
      if (priority !== undefined) updates.priority = priority;
      if (assigneeAgent !== undefined) updates.assigneeAgent = assigneeAgent;
      const ticket = deps.tickets.update(ticketId, updates);
      return JSON.stringify({ updated: true, id: ticket.id, identifier: ticket.identifier });
    },
    {
      name: 'org_update_ticket',
      description: 'Update a ticket\'s title, description, priority, or assignee.',
      schema: z.object({
        ticketId: z.string().describe('Ticket ID'),
        title: z.string().min(1).max(500).optional().describe('New title'),
        description: z.string().max(10000).optional().describe('New description'),
        priority: TicketPriority.optional().describe('New priority'),
        assigneeAgent: z.string().optional().describe('Agent name to assign'),
      }),
    },
  ));

  tools.set('transition_ticket', tool(
    async ({ ticketId, status }) => {
      const ticket = deps.tickets.transition(ticketId, status);
      return JSON.stringify({ transitioned: true, id: ticket.id, identifier: ticket.identifier, status: ticket.status });
    },
    {
      name: 'org_transition_ticket',
      description: 'Change a ticket\'s status (e.g. backlog → todo → in_progress → in_review → done).',
      schema: z.object({
        ticketId: z.string().describe('Ticket ID'),
        status: TicketStatus.describe('New status: backlog, todo, in_progress, in_review, blocked, done, cancelled'),
      }),
    },
  ));

  tools.set('add_comment', tool(
    async ({ ticketId, content, authorName }) => {
      deps.tickets.addComment(ticketId, content, 'agent', authorName || 'CEO');
      return JSON.stringify({ commented: true });
    },
    {
      name: 'org_add_comment',
      description: 'Add a comment to a ticket.',
      schema: z.object({
        ticketId: z.string().describe('Ticket ID'),
        content: z.string().min(1).describe('Comment text'),
        authorName: z.string().default('CEO').describe('Author name for the comment'),
      }),
    },
  ));

  tools.set('execute_ticket', tool(
    async ({ ticketId, agentName, input }) => {
      const ticket = deps.tickets.get(ticketId);
      if (!ticket) return JSON.stringify({ error: `Ticket not found: ${ticketId}` });

      // Assign agent if provided
      if (agentName && ticket.assigneeAgent !== agentName) {
        deps.tickets.update(ticketId, { assigneeAgent: agentName });
      }
      const agent = agentName || ticket.assigneeAgent;
      if (!agent) return JSON.stringify({ error: 'No agent assigned. Set assigneeAgent first.' });

      deps.tickets.transition(ticketId, 'in_progress');
      deps.tickets.addTaskEvent(ticketId, `CEO delegated to ${agent}`);

      const task = deps.submitAgent({
        agent,
        input: { query: input || `Work on ticket ${ticket.identifier}: ${ticket.title}\n\n${ticket.description}` },
      });

      deps.tickets.linkTask(ticketId, task.id);
      return JSON.stringify({ executed: true, taskId: task.id, agent, ticketIdentifier: ticket.identifier });
    },
    {
      name: 'org_execute_ticket',
      description: 'Delegate a ticket to an agent for execution. Transitions ticket to in_progress and starts an async task.',
      schema: z.object({
        ticketId: z.string().describe('Ticket ID'),
        agentName: z.string().optional().describe('Agent to execute (uses current assignee if omitted)'),
        input: z.string().optional().describe('Custom instructions for the agent (defaults to ticket title + description)'),
      }),
    },
  ));

  tools.set('list_members', tool(
    async () => {
      const members = deps.orgChart.list(deps.orgId);
      return JSON.stringify(members.map(m => ({
        id: m.id, agentName: m.agentName, title: m.title, role: m.role, reportsTo: m.reportsTo,
      })));
    },
    {
      name: 'org_list_members',
      description: 'List all members in your org chart.',
      schema: z.object({}),
    },
  ));

  tools.set('add_member', tool(
    async ({ agentName, title, role, reportsTo }) => {
      const member = deps.orgChart.create(deps.orgId, { agentName, title, role, reportsTo, position: 0 });
      return JSON.stringify({ added: true, id: member.id, agentName: member.agentName });
    },
    {
      name: 'org_add_member',
      description: 'Add an agent to the org chart.',
      schema: z.object({
        agentName: z.string().min(1).describe('Agent name (must exist in workspace)'),
        title: z.string().max(200).default('').describe('Job title'),
        role: OrgMemberRole.default('member').describe('Role: ceo, manager, member'),
        reportsTo: z.string().nullable().default(null).describe('ID of the member this agent reports to (null for top-level)'),
      }),
    },
  ));

  tools.set('remove_member', tool(
    async ({ memberId }) => {
      deps.orgChart.delete(memberId);
      return JSON.stringify({ removed: true });
    },
    {
      name: 'org_remove_member',
      description: 'Remove a member from the org chart.',
      schema: z.object({
        memberId: z.string().describe('Member ID to remove'),
      }),
    },
  ));

  logger.info(`[OrgTools] Built ${tools.size} organization tools for org ${deps.orgId}`);
  return tools;
}
