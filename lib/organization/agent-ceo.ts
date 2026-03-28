import type { Organization, Ticket } from './types.ts';
import type { OrgChartManager } from './org-chart-manager.ts';
import { logger } from '../logger.ts';

interface AgentCEODeps {
  runAgent: (
    agentName: string,
    input: Record<string, unknown>,
    sessionId?: string,
    orgContext?: import('./types.ts').AgentOrgContext,
  ) => Promise<{ id: string; output?: unknown }>;
  submitAgent: (params: {
    agent: string;
    input: Record<string, unknown>;
    orgContext?: import('./types.ts').AgentOrgContext;
    onComplete?: (result: { output: unknown }) => void;
    onError?: (error: string) => void;
  }) => { id: string };
  orgChart: OrgChartManager;
  listAgents: () => { name: string; description?: string }[];
  listTickets: (orgId: string) => { identifier: string; title: string; status: string; priority: string; assigneeAgent: string }[];
}

export class AgentCEO {
  private orgId: string;
  private agentName: string;
  private deps: AgentCEODeps;

  constructor(orgId: string, agentName: string, deps: AgentCEODeps) {
    this.orgId = orgId;
    this.agentName = agentName;
    this.deps = deps;
  }

  async handleTicket(org: Organization, ticket: Ticket): Promise<{ taskId: string }> {
    const members = this.deps.orgChart.list(this.orgId);
    const agents = this.deps.listAgents();
    const allTickets = this.deps.listTickets(this.orgId);
    const activeTickets = allTickets.filter(t => t.identifier !== ticket.identifier && t.status !== 'done' && t.status !== 'cancelled');

    const orgChartSummary = members.map(m =>
      `- ${m.agentName} (${m.role}${m.title ? `, ${m.title}` : ''})`
    ).join('\n') || 'No members assigned yet.';

    const availableAgents = agents.map(a =>
      `- ${a.name}${a.description ? `: ${a.description}` : ''}`
    ).join('\n') || 'No agents loaded.';

    const activeTicketsSummary = activeTickets.length > 0
      ? activeTickets.map(t => `- ${t.identifier}: ${t.title} [${t.status}] ${t.priority}${t.assigneeAgent ? ` → ${t.assigneeAgent}` : ''}`).join('\n')
      : 'No other active tickets.';

    const ceoPrompt = `You are the CEO of organization "${org.name}" (${org.issuePrefix}).

## Your Org Chart
${orgChartSummary}

## Available Agents in Workspace
${availableAgents}

## Active Tickets in Organization
${activeTicketsSummary}

## Ticket to Triage
**${ticket.identifier}**: ${ticket.title}
Priority: ${ticket.priority}
${ticket.description ? `\nDescription:\n${ticket.description}` : ''}

## Instructions
You are fully autonomous — do NOT ask for permission or direction. Decide and act:
1. Execute the work yourself if you're the best fit
2. Delegate to a specific org member by updating the ticket's assignee and executing it
3. Create a new agent if no existing agent fits the task, then delegate to it

Make a decision and execute it now.`;

    const orgContext = {
      organization: {
        id: org.id,
        name: org.name,
        description: org.description,
        prefix: org.issuePrefix,
      },
      ticket: {
        identifier: ticket.identifier,
        title: ticket.title,
        priority: ticket.priority,
        description: ticket.description,
      },
      orgChart: members.map(m => ({ agentName: m.agentName, role: m.role, title: m.title })),
      activeTickets: activeTickets.map(t => ({ identifier: t.identifier, title: t.title, status: t.status, priority: t.priority, assigneeAgent: t.assigneeAgent })),
    };

    const task = this.deps.submitAgent({
      agent: this.agentName,
      input: { query: ceoPrompt },
      orgContext,
    });

    logger.info(`[AgentCEO] CEO "${this.agentName}" triaging ticket ${ticket.identifier} (task: ${task.id})`);
    return { taskId: task.id };
  }

  async reviewTicket(org: Organization, ticket: Ticket, agentOutput: string): Promise<{ taskId: string }> {
    const reviewPrompt = `You are the CEO of organization "${org.name}" (${org.issuePrefix}).

## Review Request
An agent completed work on ticket **${ticket.identifier}**: ${ticket.title}

## Agent Output
${agentOutput.length > 3000 ? agentOutput.slice(0, 3000) + '\n\n... (truncated)' : agentOutput}

## Instructions
Review this work for quality, completeness, and correctness.
- If satisfactory, note your approval
- If improvements are needed, provide specific feedback`;

    const orgContext = {
      organization: {
        id: org.id,
        name: org.name,
        description: org.description,
        prefix: org.issuePrefix,
      },
      ticket: {
        identifier: ticket.identifier,
        title: ticket.title,
        priority: ticket.priority,
        description: ticket.description,
      },
    };

    const task = this.deps.submitAgent({
      agent: this.agentName,
      input: { query: reviewPrompt },
      orgContext,
    });

    logger.info(`[AgentCEO] CEO "${this.agentName}" reviewing ticket ${ticket.identifier} (task: ${task.id})`);
    return { taskId: task.id };
  }

  async executeHeartbeat(org: Organization, prompt: string): Promise<{ output: string; taskId: string }> {
    const orgContext = {
      organization: {
        id: org.id,
        name: org.name,
        description: org.description,
        prefix: org.issuePrefix,
      },
    };

    // Use submitAgent which returns immediately with a task ID
    // The actual output comes asynchronously
    const task = this.deps.submitAgent({
      agent: this.agentName,
      input: { query: prompt },
      orgContext,
    });

    logger.info(`[AgentCEO] CEO "${this.agentName}" heartbeat started (task: ${task.id})`);
    return { output: '', taskId: task.id };
  }
}
