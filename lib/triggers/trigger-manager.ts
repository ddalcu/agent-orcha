import { CronTriggerHandler } from './cron-trigger.ts';
import { WebhookTriggerHandler } from './webhook-trigger.ts';
import { createLogger } from '../logger.ts';
import type { FastifyInstance } from 'fastify';
import type { Orchestrator } from '../orchestrator.ts';

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

  removeAgentTriggers(agentName: string): void {
    // Stop and remove cron handlers for this agent
    const remainingCron: CronTriggerHandler[] = [];
    for (const handler of this.cronHandlers) {
      if (handler.agentName === agentName) {
        handler.stop();
        log.info(`Removed cron trigger for agent "${agentName}"`);
      } else {
        remainingCron.push(handler);
      }
    }
    this.cronHandlers = remainingCron;

    // Remove webhook handlers for this agent
    // (Fastify routes can't be unregistered, but removing from list prevents new registrations)
    const remainingWebhook: WebhookTriggerHandler[] = [];
    for (const handler of this.webhookHandlers) {
      if (handler.agentName === agentName) {
        log.info(`Removed webhook trigger for agent "${agentName}" at ${handler.path}`);
      } else {
        remainingWebhook.push(handler);
      }
    }
    this.webhookHandlers = remainingWebhook;
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
