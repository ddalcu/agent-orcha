import { CronTriggerHandler } from './cron-trigger.js';
import { WebhookTriggerHandler } from './webhook-trigger.js';
import { createLogger } from '../logger.js';
import type { FastifyInstance } from 'fastify';
import type { Orchestrator } from '../orchestrator.js';

const log = createLogger('TriggerManager');

export class TriggerManager {
  private cronHandlers: CronTriggerHandler[] = [];
  private webhookHandlers: WebhookTriggerHandler[] = [];

  async start(orchestrator: Orchestrator, fastify: FastifyInstance): Promise<void> {
    const agents = orchestrator.agents.list();
    const registeredPaths = new Set<string>();

    for (const agent of agents) {
      if (!agent.triggers || agent.triggers.length === 0) continue;

      for (const trigger of agent.triggers) {
        if (trigger.type === 'cron') {
          const handler = new CronTriggerHandler(agent.name, trigger, orchestrator);
          handler.start();
          this.cronHandlers.push(handler);
        }

        if (trigger.type === 'webhook') {
          const handler = new WebhookTriggerHandler(agent.name, trigger, orchestrator);

          if (registeredPaths.has(handler.path)) {
            log.error(`Webhook path collision: "${handler.path}" already registered, skipping for agent "${agent.name}"`);
            continue;
          }

          handler.register(fastify);
          registeredPaths.add(handler.path);
          this.webhookHandlers.push(handler);
        }
      }
    }

    const total = this.cronHandlers.length + this.webhookHandlers.length;
    if (total > 0) {
      log.info(`Started ${this.cronHandlers.length} cron trigger(s) and ${this.webhookHandlers.length} webhook trigger(s)`);
    }
  }

  close(): void {
    for (const handler of this.cronHandlers) {
      handler.stop();
    }
    this.cronHandlers = [];
    this.webhookHandlers = [];
  }

  get cronCount(): number {
    return this.cronHandlers.length;
  }

  get webhookCount(): number {
    return this.webhookHandlers.length;
  }
}
