import cron from 'node-cron';
import { createLogger } from '../logger.js';
import type { Orchestrator } from '../orchestrator.js';
import type { CronTrigger } from './types.js';

const log = createLogger('CronTrigger');

export class CronTriggerHandler {
  private task: cron.ScheduledTask | null = null;

  constructor(
    private agentName: string,
    private trigger: CronTrigger,
    private orchestrator: Orchestrator,
  ) {}

  start(): void {
    const sessionId = `trigger-${this.agentName}-cron`;

    this.task = cron.schedule(this.trigger.schedule, async () => {
      try {
        log.info(`Cron firing for agent "${this.agentName}"`);
        const channelContext = this.orchestrator.integrations.getChannelContext(this.agentName);
        const input = channelContext
          ? { ...this.trigger.input, channelContext }
          : { ...this.trigger.input };
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
