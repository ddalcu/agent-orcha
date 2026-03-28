import cron from 'node-cron';
import * as fs from 'fs';
import * as path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import type { HeartbeatConfig, CEORun } from './types.ts';
import type { OrgManager } from './org-manager.ts';
import type { TicketManager } from './ticket-manager.ts';
import type { OrgChartManager } from './org-chart-manager.ts';
import type { CEOCoordinator } from './ceo-coordinator.ts';
import type { CEORunManager } from './ceo-run-manager.ts';
import { logger } from '../logger.ts';

interface HeartbeatDeps {
  db: DatabaseSync;
  orgs: OrgManager;
  tickets: TicketManager;
  orgChart: OrgChartManager;
  ceo: CEOCoordinator;
  ceoRuns: CEORunManager;
  listAgents: () => { name: string; description?: string }[];
  trackTask: (target: string, input: Record<string, unknown>) => { id: string };
  resolveTask: (taskId: string, result: unknown) => void;
  rejectTask: (taskId: string, error: string) => void;
  addTaskEvent: (taskId: string, event: { type: string; timestamp: number; content?: string; tool?: string; input?: unknown; output?: unknown }) => void;
  workspaceRoot: string;
}

export class HeartbeatManager {
  private deps: HeartbeatDeps;
  private cronJobs = new Map<string, cron.ScheduledTask>();

  constructor(deps: HeartbeatDeps) {
    this.deps = deps;
  }

  getConfig(orgId: string): HeartbeatConfig | undefined {
    return this.deps.db.prepare('SELECT * FROM heartbeat_config WHERE orgId = ?')
      .get(orgId) as HeartbeatConfig | undefined;
  }

  configureHeartbeat(orgId: string, data: { enabled: boolean; schedule: string; timezone?: string }): HeartbeatConfig {
    const org = this.deps.orgs.get(orgId);
    if (!org) throw new Error(`Organization not found: ${orgId}`);

    if (!cron.validate(data.schedule)) {
      throw new Error(`Invalid cron expression: ${data.schedule}`);
    }

    const now = new Date().toISOString();
    const existing = this.getConfig(orgId);

    if (existing) {
      this.deps.db.prepare(`
        UPDATE heartbeat_config SET enabled = ?, schedule = ?, timezone = ?, updatedAt = ? WHERE orgId = ?
      `).run(data.enabled ? 1 : 0, data.schedule, data.timezone || 'UTC', now, orgId);
    } else {
      this.deps.db.prepare(`
        INSERT INTO heartbeat_config (orgId, enabled, schedule, timezone, contextSnapshot, updatedAt)
        VALUES (?, ?, ?, ?, '', ?)
      `).run(orgId, data.enabled ? 1 : 0, data.schedule, data.timezone || 'UTC', now);
    }

    // Reschedule
    this.stopCronJob(orgId);
    if (data.enabled) {
      const config = this.getConfig(orgId)!;
      this.scheduleCronJob(orgId, config);
    }

    logger.info(`[HeartbeatManager] Configured heartbeat for org ${org.name}: ${data.enabled ? data.schedule : 'disabled'}`);
    return this.getConfig(orgId)!;
  }

  async triggerHeartbeat(orgId: string, triggerSource = 'manual'): Promise<CEORun> {
    return this.executeHeartbeat(orgId, triggerSource);
  }

  /** Force stop a running CEO and mark the run as failed */
  forceStop(orgId: string): { stopped: boolean } {
    // Kill the CEO process
    const killed = this.deps.ceo.forceStop(orgId);

    // Mark the latest running CEO run as failed
    const latestRun = this.deps.ceoRuns.getLatestRun(orgId);
    if (latestRun?.status === 'running') {
      this.deps.ceoRuns.failRun(latestRun.id, 'Force stopped by user');
      // Also fail the linked task
      if (latestRun.taskId) {
        this.deps.rejectTask(latestRun.taskId, 'Force stopped by user');
      }
    }

    logger.info(`[HeartbeatManager] Force stopped CEO for org ${orgId} (process killed: ${killed})`);
    return { stopped: true };
  }

  /** Wraps any CEO action with run tracking */
  async trackCEOAction<T>(orgId: string, type: string, triggerSource: string, fn: () => Promise<T>): Promise<{ run: CEORun; result: T }> {
    const run = this.deps.ceoRuns.startRun(orgId, type, triggerSource);
    try {
      const result = await fn();
      const completedRun = this.deps.ceoRuns.completeRun(run.id, {});
      return { run: completedRun, result };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const failedRun = this.deps.ceoRuns.failRun(run.id, errorMsg);
      throw Object.assign(err instanceof Error ? err : new Error(errorMsg), { ceoRun: failedRun });
    }
  }

  startAllHeartbeats(): void {
    const configs = this.deps.db.prepare('SELECT * FROM heartbeat_config WHERE enabled = 1')
      .all() as HeartbeatConfig[];

    for (const config of configs) {
      const org = this.deps.orgs.get(config.orgId);
      if (!org || !org.ceoType) continue;
      this.scheduleCronJob(config.orgId, config);
    }

    logger.info(`[HeartbeatManager] Started ${configs.length} heartbeat cron jobs`);
  }

  stopAll(): void {
    for (const [id, job] of this.cronJobs) {
      job.stop();
      this.cronJobs.delete(id);
    }
    logger.info('[HeartbeatManager] All heartbeat cron jobs stopped');
  }

  private scheduleCronJob(orgId: string, config: HeartbeatConfig): void {
    this.stopCronJob(orgId);

    const job = cron.schedule(config.schedule, () => {
      this.executeHeartbeat(orgId, 'cron').catch(err => {
        logger.error(`[HeartbeatManager] Heartbeat failed for org ${orgId}: ${err}`);
      });
    }, { timezone: config.timezone || undefined });

    this.cronJobs.set(orgId, job);
  }

  private stopCronJob(orgId: string): void {
    const existing = this.cronJobs.get(orgId);
    if (existing) {
      existing.stop();
      this.cronJobs.delete(orgId);
    }
  }

  private async executeHeartbeat(orgId: string, triggerSource: string): Promise<CEORun> {
    const org = this.deps.orgs.get(orgId);
    if (!org) throw new Error(`Organization not found: ${orgId}`);
    if (!org.ceoType) throw new Error('No CEO configured for this organization');

    // Skip if CEO is already running (prevent overlapping heartbeats)
    const latestRun = this.deps.ceoRuns.getLatestRun(orgId);
    if (latestRun?.status === 'running') {
      logger.info(`[HeartbeatManager] Skipping heartbeat for org ${org.name} — CEO is already running (run: ${latestRun.id})`);
      return latestRun;
    }

    // Register in task system so it appears in Monitor tab
    const ceoLabel = org.ceoType === 'claude-code' ? `CEO (Claude Code)` : `CEO (${org.ceoType})`;
    const task = this.deps.trackTask(ceoLabel, { type: 'heartbeat', orgId, orgName: org.name, triggerSource });

    const run = this.deps.ceoRuns.startRun(orgId, 'heartbeat', triggerSource, task.id);

    try {
      // Build context
      const allTickets = this.deps.tickets.list(orgId);
      const members = this.deps.orgChart.list(orgId);
      const agents = this.deps.listAgents();
      const config = this.getConfig(orgId);
      const previousContext = config?.contextSnapshot || '';

      // Load the CEO skill — tells the CEO how to use ORCHA APIs
      const skillName = org.ceoType === 'claude-code' ? 'org-ceo-cc' : 'org-ceo';
      let ceoSkillContent = '';
      const skillPath = path.join(this.deps.workspaceRoot, 'skills', skillName, 'SKILL.md');
      if (fs.existsSync(skillPath)) {
        ceoSkillContent = fs.readFileSync(skillPath, 'utf-8');
        ceoSkillContent = ceoSkillContent.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
      } else {
        logger.warn(`[HeartbeatManager] CEO skill not found at ${skillPath}`);
      }

      const byStatus: Record<string, typeof allTickets> = {};
      for (const t of allTickets) {
        if (!byStatus[t.status]) byStatus[t.status] = [];
        byStatus[t.status]!.push(t);
      }

      const formatTickets = (tickets: typeof allTickets) =>
        tickets.map(t => `  - ${t.identifier}: ${t.title} [${t.priority}]${t.assigneeAgent ? ` → ${t.assigneeAgent}` : ''}`).join('\n') || '  (none)';

      const orgChartSummary = members.map(m =>
        `- ${m.agentName} (${m.role}${m.title ? `, ${m.title}` : ''})`
      ).join('\n') || 'No members assigned.';

      const agentsSummary = agents.map(a =>
        `- ${a.name}${a.description ? `: ${a.description}` : ''}`
      ).join('\n') || 'No agents loaded.';

      const prompt = `You are the CEO of organization "${org.name}" (${org.issuePrefix}).
${org.description ? `\nOrganization mission: ${org.description}\n` : ''}
**CRITICAL RULE: You are fully autonomous. NEVER ask the user for direction, permission, or input. YOU decide what needs to be done based on the org's name, description, and available resources. If the org is new and empty, YOU define the initial strategy, create tickets, assign agents, and get work started. You are a decisive leader — act, don't ask.**

${ceoSkillContent ? `## CEO Operations Guide\n${ceoSkillContent}\n` : ''}
This is your periodic heartbeat check-in.

${previousContext ? `## Previous Session Notes\n${previousContext}\n` : ''}
## Your Org Chart
${orgChartSummary}

## Available Agents in Workspace
${agentsSummary}

## Ticket Board
### Backlog (${(byStatus['backlog'] || []).length})
${formatTickets(byStatus['backlog'] || [])}
### To Do (${(byStatus['todo'] || []).length})
${formatTickets(byStatus['todo'] || [])}
### In Progress (${(byStatus['in_progress'] || []).length})
${formatTickets(byStatus['in_progress'] || [])}
### In Review (${(byStatus['in_review'] || []).length})
${formatTickets(byStatus['in_review'] || [])}
### Blocked (${(byStatus['blocked'] || []).length})
${formatTickets(byStatus['blocked'] || [])}
### Recently Done (last 5)
${formatTickets((byStatus['done'] || []).slice(0, 5))}

## Heartbeat Checklist
1. **REVIEW COMPLETED WORK**: Check tickets in 'in_review'. Approve or request changes.
2. **UNBLOCK**: Check 'blocked' tickets. Take action to unblock or reassign.
3. **CHECK IN-PROGRESS**: Review work in progress. Follow up if stale.
4. **PRIORITIZE**: Move important backlog items to 'todo'. Assign and execute if ready.
5. **CREATE NEW WORK**: If the board is empty or light, create tickets based on the org's mission and what makes sense. Match tasks to available agents. Be proactive — don't wait for instructions.
6. **STAFF UP**: If the org chart is empty, add relevant agents from the available workspace agents. Pick agents whose descriptions match the org's needs.
7. **STATUS REPORT**: Summarize what you did and the current org state.
8. **HANDOFF NOTES**: Write context notes for your next heartbeat (key decisions, in-flight work, what to check next).

## Instructions
Execute this checklist NOW. Take real actions — create tickets, assign agents, add org members, execute work. Do NOT ask what to do. You ARE the decision maker.

At the end, provide:
- A brief **status report** summarizing what you did and the org state
- **Handoff notes** for your next heartbeat`;

      // Execute via CEO coordinator
      // Pipe Claude Code stream events into the task system for Monitor visibility
      const onEvent = (event: { type: string; content?: string; tool?: string; input?: unknown; output?: unknown }) => {
        this.deps.addTaskEvent(task.id, { ...event, timestamp: Date.now() });
      };

      const result = await this.deps.ceo.executeHeartbeat(orgId, prompt, onEvent);

      // Parse output for handoff notes (look for a section after "Handoff" or "Notes")
      const output = result.output || '';
      let summary = output;
      let handoffNotes = '';

      // Try to extract handoff notes from output
      const handoffMatch = output.match(/(?:handoff|notes for next|session notes|context for next)[:\s]*\n([\s\S]*?)(?:\n##|\n---|\Z)/i);
      if (handoffMatch) {
        handoffNotes = handoffMatch[1]?.trim() || '';
      }

      // Truncate summary for storage
      if (summary.length > 4000) {
        summary = summary.slice(0, 4000) + '\n\n... (truncated)';
      }

      // Persist handoff notes for next heartbeat
      if (handoffNotes && config) {
        this.deps.db.prepare('UPDATE heartbeat_config SET contextSnapshot = ?, updatedAt = ? WHERE orgId = ?')
          .run(handoffNotes, new Date().toISOString(), orgId);
      }

      const completedRun = this.deps.ceoRuns.completeRun(run.id, {
        summary,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: result.costUsd,
        sessionId: result.sessionId,
      });

      this.deps.resolveTask(task.id, { summary, type: 'heartbeat' });
      logger.info(`[HeartbeatManager] Heartbeat completed for org ${org.name}`);
      return completedRun;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const failedRun = this.deps.ceoRuns.failRun(run.id, errorMsg);
      this.deps.rejectTask(task.id, errorMsg);
      logger.error(`[HeartbeatManager] Heartbeat failed for org ${org.name}: ${errorMsg}`);
      return failedRun;
    }
  }
}
