import type { OrgDashboard } from './types.ts';
import type { OrgManager } from './org-manager.ts';
import type { TicketManager } from './ticket-manager.ts';
import type { OrgChartManager } from './org-chart-manager.ts';
import type { CEORunManager } from './ceo-run-manager.ts';
import type { TaskMetricsManager } from './task-metrics-manager.ts';
import type { HeartbeatManager } from './heartbeat-manager.ts';
import type { CEOCoordinator } from './ceo-coordinator.ts';

interface DashboardDeps {
  orgs: OrgManager;
  tickets: TicketManager;
  orgChart: OrgChartManager;
  ceoRuns: CEORunManager;
  taskMetrics: TaskMetricsManager;
  heartbeat: HeartbeatManager;
  ceo: CEOCoordinator;
}

export class DashboardStats {
  private deps: DashboardDeps;

  constructor(deps: DashboardDeps) {
    this.deps = deps;
  }

  getOrgDashboard(orgId: string): OrgDashboard {
    const org = this.deps.orgs.get(orgId);
    if (!org) throw new Error(`Organization not found: ${orgId}`);

    // CEO status
    const ceoStatus = this.deps.ceo.getCEOStatus(orgId);
    const latestRun = this.deps.ceoRuns.getLatestRun(orgId);
    const hbConfig = this.deps.heartbeat.getConfig(orgId);

    let ceoConfig: Record<string, string> = {};
    try { ceoConfig = JSON.parse(org.ceoConfig || '{}'); } catch { /* empty */ }

    // Ticket stats
    const allTickets = this.deps.tickets.list(orgId);
    const byStatus: Record<string, number> = {};
    for (const t of allTickets) {
      byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    }
    const recentlyUpdated = [...allTickets]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 5);

    // Org chart
    const members = this.deps.orgChart.list(orgId);

    // CEO run stats
    const runs = this.deps.ceoRuns.listRuns(orgId, 10);
    const runStats = this.deps.ceoRuns.getStats(orgId);

    // Task stats
    const taskStats = this.deps.taskMetrics.getOrgStats(orgId);

    return {
      ceo: {
        configured: ceoStatus.configured,
        type: ceoStatus.type,
        agentName: ceoConfig.agentName,
        status: latestRun?.status === 'running' ? 'working' : 'idle',
        lastRunAt: latestRun?.startedAt,
        lastRunSummary: latestRun?.summary,
        heartbeatEnabled: hbConfig ? hbConfig.enabled === 1 : false,
        heartbeatSchedule: hbConfig?.schedule,
      },
      runs,
      runStats,
      tickets: {
        total: allTickets.length,
        byStatus,
        recentlyUpdated,
      },
      agents: {
        total: members.length,
        members: members.map(m => ({ agentName: m.agentName, role: m.role, title: m.title })),
      },
      taskStats,
    };
  }
}
