import type { Organization } from './types.ts';
import type { OrgManager } from './org-manager.ts';
import type { TicketManager } from './ticket-manager.ts';
import type { OrgChartManager } from './org-chart-manager.ts';
import { AgentCEO } from './agent-ceo.ts';
import { ClaudeCodeCEO } from './claude-code-ceo.ts';

interface CEOCoordinatorDeps {
  orgs: OrgManager;
  tickets: TicketManager;
  orgChart: OrgChartManager;
  runAgent: (
    agentName: string,
    input: Record<string, unknown>,
    sessionId?: string,
    orgContext?: { organization: { id: string; name: string; description: string; prefix: string }; ticket?: { identifier: string; title: string; priority: string; description: string } },
  ) => Promise<{ id: string; output?: unknown }>;
  submitAgent: (params: {
    agent: string;
    input: Record<string, unknown>;
    orgContext?: { organization: { id: string; name: string; description: string; prefix: string }; ticket?: { identifier: string; title: string; priority: string; description: string } };
    onComplete?: (result: { output: unknown }) => void;
    onError?: (error: string) => void;
  }) => { id: string };
  listAgents: () => { name: string; description?: string }[];
  workspaceRoot: string;
}

export class CEOCoordinator {
  private agentCEOs = new Map<string, AgentCEO>();
  private ccCEOs = new Map<string, ClaudeCodeCEO>();
  private deps: CEOCoordinatorDeps;

  constructor(deps: CEOCoordinatorDeps) {
    this.deps = deps;
  }

  async handleTicket(orgId: string, ticketId: string): Promise<{ taskId?: string; output?: string }> {
    const org = this.deps.orgs.get(orgId);
    if (!org) throw new Error(`Organization not found: ${orgId}`);

    const ticket = this.deps.tickets.get(ticketId);
    if (!ticket) throw new Error(`Ticket not found: ${ticketId}`);

    if (!org.ceoType) {
      throw new Error('No CEO configured for this organization');
    }

    // Add activity to ticket
    this.deps.tickets.addTaskEvent(ticketId, `Ticket submitted to CEO (${org.ceoType})`);

    if (org.ceoType === 'agent') {
      const ceo = this.getAgentCEO(org);
      const result = await ceo.handleTicket(org, ticket);
      return { taskId: result.taskId };
    }

    if (org.ceoType === 'claude-code') {
      const ceo = this.getClaudeCodeCEO(orgId);
      const result = await ceo.handleTicket(org, ticket);
      // Log the output as a comment
      if (result.output) {
        const summary = result.output.length > 4000
          ? result.output.slice(0, 4000) + '\n\n... (truncated)'
          : result.output;
        this.deps.tickets.addComment(ticketId, summary, 'agent', 'CEO (Claude Code)');
      }
      return { output: result.output };
    }

    throw new Error(`Unknown CEO type: ${org.ceoType}`);
  }

  async reviewTicket(orgId: string, ticketId: string, agentOutput: string): Promise<{ taskId?: string; output?: string }> {
    const org = this.deps.orgs.get(orgId);
    if (!org) throw new Error(`Organization not found: ${orgId}`);

    const ticket = this.deps.tickets.get(ticketId);
    if (!ticket) throw new Error(`Ticket not found: ${ticketId}`);

    if (!org.ceoType) {
      throw new Error('No CEO configured for this organization');
    }

    this.deps.tickets.addTaskEvent(ticketId, `CEO review requested (${org.ceoType})`);

    if (org.ceoType === 'agent') {
      const ceo = this.getAgentCEO(org);
      const result = await ceo.reviewTicket(org, ticket, agentOutput);
      return { taskId: result.taskId };
    }

    if (org.ceoType === 'claude-code') {
      const ceo = this.getClaudeCodeCEO(orgId);
      const result = await ceo.reviewTicket(org, ticket, agentOutput);
      if (result.output) {
        const summary = result.output.length > 4000
          ? result.output.slice(0, 4000) + '\n\n... (truncated)'
          : result.output;
        this.deps.tickets.addComment(ticketId, summary, 'agent', 'CEO (Claude Code)');
      }
      return { output: result.output };
    }

    throw new Error(`Unknown CEO type: ${org.ceoType}`);
  }

  async executeHeartbeat(orgId: string, prompt: string, onEvent?: (event: { type: string; content?: string; tool?: string; input?: unknown; output?: unknown }) => void): Promise<{ output: string; inputTokens?: number; outputTokens?: number; costUsd?: number; sessionId?: string }> {
    const org = this.deps.orgs.get(orgId);
    if (!org) throw new Error(`Organization not found: ${orgId}`);
    if (!org.ceoType) throw new Error('No CEO configured for this organization');

    if (org.ceoType === 'agent') {
      const ceo = this.getAgentCEO(org);
      const result = await ceo.executeHeartbeat(org, prompt);
      return { output: result.output || '', taskId: result.taskId } as { output: string; taskId?: string };
    }

    if (org.ceoType === 'claude-code') {
      const ceo = this.getClaudeCodeCEO(orgId);
      const result = await ceo.executeHeartbeat(org, prompt, onEvent);
      return {
        output: result.output,
        costUsd: result.costUsd,
        sessionId: result.sessionId,
      };
    }

    throw new Error(`Unknown CEO type: ${org.ceoType}`);
  }

  forceStop(orgId: string): boolean {
    // Claude Code CEO — kill the process
    const ccCeo = this.ccCEOs.get(orgId);
    if (ccCeo) return ccCeo.forceStop();

    // Agent CEO — cancel via abort (if we have an abort controller)
    // For now, agent tasks can be cancelled via the task system
    return false;
  }

  getCEOStatus(orgId: string): { configured: boolean; type: string; agentName?: string; lastSessionId?: string } {
    const org = this.deps.orgs.get(orgId);
    if (!org || !org.ceoType) {
      return { configured: false, type: '' };
    }

    const config = this.parseCeoConfig(org.ceoConfig);
    return {
      configured: true,
      type: org.ceoType,
      agentName: config.agentName,
      lastSessionId: config.lastSessionId,
    };
  }

  /** Clear cached CEO instances (e.g. when org CEO config changes) */
  invalidate(orgId: string): void {
    this.agentCEOs.delete(orgId);
    this.ccCEOs.delete(orgId);
  }

  private getAgentCEO(org: Organization): AgentCEO {
    if (!this.agentCEOs.has(org.id)) {
      const config = this.parseCeoConfig(org.ceoConfig);
      if (!config.agentName) {
        throw new Error('Agent CEO configured but no agentName specified in ceoConfig');
      }
      this.agentCEOs.set(org.id, new AgentCEO(org.id, config.agentName, {
        runAgent: this.deps.runAgent,
        submitAgent: this.deps.submitAgent,
        orgChart: this.deps.orgChart,
        listAgents: this.deps.listAgents,
        listTickets: (orgId) => this.deps.tickets.list(orgId).map(t => ({
          identifier: t.identifier, title: t.title, status: t.status, priority: t.priority, assigneeAgent: t.assigneeAgent,
        })),
      }));
    }
    return this.agentCEOs.get(org.id)!;
  }

  private getClaudeCodeCEO(orgId: string): ClaudeCodeCEO {
    if (!this.ccCEOs.has(orgId)) {
      this.ccCEOs.set(orgId, new ClaudeCodeCEO(orgId, {
        orgChart: this.deps.orgChart,
        orgs: this.deps.orgs,
        tickets: this.deps.tickets,
        listAgents: this.deps.listAgents,
        workspaceRoot: this.deps.workspaceRoot,
      }));
    }
    return this.ccCEOs.get(orgId)!;
  }

  private parseCeoConfig(configStr: string): Record<string, string> {
    try {
      return JSON.parse(configStr || '{}');
    } catch {
      return {};
    }
  }
}
