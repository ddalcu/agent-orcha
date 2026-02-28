import cron from 'node-cron';
import { createLogger } from '../logger.ts';
import type { Orchestrator } from '../orchestrator.ts';
import type { CronTrigger } from './types.ts';

const log = createLogger('CronTrigger');

export class CronTriggerHandler {
  readonly agentName: string;
  private trigger: CronTrigger;
  private orchestrator: Orchestrator;
  private task: cron.ScheduledTask | null = null;

  constructor(agentName: string, trigger: CronTrigger, orchestrator: Orchestrator) {
    this.agentName = agentName;
    this.trigger = trigger;
    this.orchestrator = orchestrator;
  }

  start(): void {
    const sessionId = `trigger-${this.agentName}-cron`;

    this.task = cron.schedule(this.trigger.schedule, async () => {
      try {
        log.info(`Cron firing for agent "${this.agentName}"`);
        const channelContext = this.orchestrator.integrations.getChannelContext(this.agentName);
        const members = this.orchestrator.integrations.getChannelMembers(this.agentName);
        const memberList = members.map(m => m.name).join(', ');
        const input: Record<string, unknown> = { ...this.trigger.input };
        if (channelContext) input.channelContext = channelContext;
        if (memberList) input.channelMembers = memberList;
        const result = await this.orchestrator.runAgent(this.agentName, input, sessionId);
        const message = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
        this.orchestrator.integrations.postMessage(this.agentName, message);
        log.info(`Cron completed for agent "${this.agentName}"`);
      } catch (error) {
        log.error(`Cron failed for agent "${this.agentName}":`, error);
      }
    });

    log.info(`Scheduled cron for agent "${this.agentName}" [${this.trigger.schedule}]`);
  }

  stop(): void {
    if (this.task) {
      this.task.stop();
      this.task = null;
    }
  }
}
