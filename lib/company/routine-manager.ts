import { randomUUID } from 'node:crypto';
import cron from 'node-cron';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Routine, CreateRoutineInput, UpdateRoutineInput, RoutineRun } from './types.ts';
import { CreateRoutineSchema, UpdateRoutineSchema } from './types.ts';
import type { CompanyManager } from './company-manager.ts';
import { logger } from '../logger.ts';

type RunAgentFn = (
  agentName: string,
  input: Record<string, unknown>,
  sessionId?: string,
  companyContext?: { company: { id: string; name: string; description: string; prefix: string } },
) => Promise<{ taskId: string }>;

export class RoutineManager {
  private db: DatabaseSync;
  private companyManager: CompanyManager;
  private cronJobs = new Map<string, cron.ScheduledTask>();
  private runAgentFn: RunAgentFn | null = null;

  constructor(db: DatabaseSync, companyManager: CompanyManager) {
    this.db = db;
    this.companyManager = companyManager;
  }

  setRunAgentFn(fn: RunAgentFn): void {
    this.runAgentFn = fn;
  }

  list(companyId?: string): Routine[] {
    if (companyId) {
      return this.db.prepare('SELECT * FROM routines WHERE companyId = ? ORDER BY name').all(companyId) as Routine[];
    }
    return this.db.prepare('SELECT * FROM routines ORDER BY name').all() as Routine[];
  }

  get(id: string): Routine | undefined {
    return this.db.prepare('SELECT * FROM routines WHERE id = ?').get(id) as Routine | undefined;
  }

  create(companyId: string, data: CreateRoutineInput): Routine {
    const parsed = CreateRoutineSchema.parse(data);
    const company = this.companyManager.get(companyId);
    if (!company) throw new Error(`Company not found: ${companyId}`);

    if (!cron.validate(parsed.schedule)) {
      throw new Error(`Invalid cron expression: ${parsed.schedule}`);
    }

    const now = new Date().toISOString();
    const id = randomUUID();
    const agentInputJson = JSON.stringify(parsed.agentInput);

    this.db.prepare(`
      INSERT INTO routines (id, companyId, name, description, schedule, timezone, agentName, agentInput, status, lastTriggeredAt, nextRunAt, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', '', '', ?, ?)
    `).run(id, companyId, parsed.name, parsed.description, parsed.schedule, parsed.timezone, parsed.agentName, agentInputJson, now, now);

    const routine = this.get(id)!;
    this.scheduleCronJob(routine);

    logger.info(`[RoutineManager] Created routine: ${parsed.name} (${parsed.schedule})`);
    return routine;
  }

  update(id: string, data: UpdateRoutineInput): Routine {
    const parsed = UpdateRoutineSchema.parse(data);
    const routine = this.get(id);
    if (!routine) throw new Error(`Routine not found: ${id}`);

    if (parsed.schedule && !cron.validate(parsed.schedule)) {
      throw new Error(`Invalid cron expression: ${parsed.schedule}`);
    }

    const fields: string[] = [];
    const values: SQLInputValue[] = [];

    if (parsed.name !== undefined) { fields.push('name = ?'); values.push(parsed.name); }
    if (parsed.description !== undefined) { fields.push('description = ?'); values.push(parsed.description); }
    if (parsed.schedule !== undefined) { fields.push('schedule = ?'); values.push(parsed.schedule); }
    if (parsed.timezone !== undefined) { fields.push('timezone = ?'); values.push(parsed.timezone); }
    if (parsed.agentName !== undefined) { fields.push('agentName = ?'); values.push(parsed.agentName); }
    if (parsed.agentInput !== undefined) { fields.push('agentInput = ?'); values.push(JSON.stringify(parsed.agentInput)); }

    if (fields.length === 0) return routine;

    fields.push('updatedAt = ?');
    values.push(new Date().toISOString());
    values.push(id);

    this.db.prepare(`UPDATE routines SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    const updated = this.get(id)!;

    // Reschedule if schedule or status relevant fields changed
    if (parsed.schedule || parsed.timezone) {
      this.stopCronJob(id);
      if (updated.status === 'active') {
        this.scheduleCronJob(updated);
      }
    }

    logger.info(`[RoutineManager] Updated routine: ${updated.name}`);
    return updated;
  }

  pause(id: string): Routine {
    const routine = this.get(id);
    if (!routine) throw new Error(`Routine not found: ${id}`);

    this.db.prepare('UPDATE routines SET status = ?, updatedAt = ? WHERE id = ?')
      .run('paused', new Date().toISOString(), id);
    this.stopCronJob(id);

    logger.info(`[RoutineManager] Paused routine: ${routine.name}`);
    return this.get(id)!;
  }

  resume(id: string): Routine {
    const routine = this.get(id);
    if (!routine) throw new Error(`Routine not found: ${id}`);

    this.db.prepare('UPDATE routines SET status = ?, updatedAt = ? WHERE id = ?')
      .run('active', new Date().toISOString(), id);

    const updated = this.get(id)!;
    this.scheduleCronJob(updated);

    logger.info(`[RoutineManager] Resumed routine: ${updated.name}`);
    return updated;
  }

  delete(id: string): void {
    const routine = this.get(id);
    if (!routine) throw new Error(`Routine not found: ${id}`);

    this.stopCronJob(id);
    this.db.prepare('DELETE FROM routines WHERE id = ?').run(id);
    logger.info(`[RoutineManager] Deleted routine: ${routine.name}`);
  }

  getRuns(routineId: string, limit = 50): RoutineRun[] {
    return this.db.prepare('SELECT * FROM routine_runs WHERE routineId = ? ORDER BY triggeredAt DESC LIMIT ?')
      .all(routineId, limit) as RoutineRun[];
  }

  async trigger(id: string): Promise<RoutineRun> {
    const routine = this.get(id);
    if (!routine) throw new Error(`Routine not found: ${id}`);
    return this.executeRoutine(routine);
  }

  startCronJobs(): void {
    const activeRoutines = this.db.prepare("SELECT * FROM routines WHERE status = 'active'").all() as Routine[];
    for (const routine of activeRoutines) {
      this.scheduleCronJob(routine);
    }
    logger.info(`[RoutineManager] Started ${activeRoutines.length} cron jobs`);
  }

  stopAll(): void {
    for (const [id, job] of this.cronJobs) {
      job.stop();
      this.cronJobs.delete(id);
    }
    logger.info('[RoutineManager] All cron jobs stopped');
  }

  private scheduleCronJob(routine: Routine): void {
    this.stopCronJob(routine.id);

    const job = cron.schedule(routine.schedule, () => {
      this.executeRoutine(routine).catch(err => {
        logger.error(`[RoutineManager] Error executing routine ${routine.name}: ${err}`);
      });
    }, { timezone: routine.timezone || undefined });

    this.cronJobs.set(routine.id, job);
  }

  private stopCronJob(id: string): void {
    const existing = this.cronJobs.get(id);
    if (existing) {
      existing.stop();
      this.cronJobs.delete(id);
    }
  }

  private async executeRoutine(routine: Routine): Promise<RoutineRun> {
    const now = new Date().toISOString();
    const runId = randomUUID();

    // Create run record
    this.db.prepare(`
      INSERT INTO routine_runs (id, routineId, taskId, status, triggeredAt, completedAt, error, createdAt)
      VALUES (?, ?, '', 'triggered', ?, '', '', ?)
    `).run(runId, routine.id, now, now);

    // Update routine timestamps
    this.db.prepare('UPDATE routines SET lastTriggeredAt = ?, updatedAt = ? WHERE id = ?')
      .run(now, now, routine.id);

    if (!this.runAgentFn) {
      this.updateRun(runId, 'failed', 'No agent execution function configured');
      return this.db.prepare('SELECT * FROM routine_runs WHERE id = ?').get(runId) as RoutineRun;
    }

    const company = this.companyManager.get(routine.companyId);
    if (!company) {
      this.updateRun(runId, 'failed', `Company not found: ${routine.companyId}`);
      return this.db.prepare('SELECT * FROM routine_runs WHERE id = ?').get(runId) as RoutineRun;
    }

    try {
      let agentInput: Record<string, unknown>;
      try {
        agentInput = JSON.parse(routine.agentInput);
      } catch {
        agentInput = {};
      }

      const companyContext = {
        company: {
          id: company.id,
          name: company.name,
          description: company.description,
          prefix: company.issuePrefix,
        },
      };

      const result = await this.runAgentFn(
        routine.agentName,
        agentInput,
        undefined,
        companyContext,
      );

      // Link task ID
      this.db.prepare('UPDATE routine_runs SET taskId = ? WHERE id = ?').run(result.taskId, runId);
      this.updateRun(runId, 'completed');

      logger.info(`[RoutineManager] Routine ${routine.name} executed successfully (task: ${result.taskId})`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.updateRun(runId, 'failed', errorMsg);
      logger.error(`[RoutineManager] Routine ${routine.name} failed: ${errorMsg}`);
    }

    return this.db.prepare('SELECT * FROM routine_runs WHERE id = ?').get(runId) as RoutineRun;
  }

  private updateRun(runId: string, status: string, error = ''): void {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE routine_runs SET status = ?, completedAt = ?, error = ? WHERE id = ?')
      .run(status, now, error, runId);
  }
}
