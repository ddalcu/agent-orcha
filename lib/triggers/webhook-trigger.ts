import { createLogger } from '../logger.ts';
import type { FastifyInstance } from 'fastify';
import type { Orchestrator } from '../orchestrator.ts';
import type { WebhookTrigger } from './types.ts';

const log = createLogger('WebhookTrigger');

export class WebhookTriggerHandler {
  readonly agentName: string;
  private trigger: WebhookTrigger;
  private orchestrator: Orchestrator;
  readonly path: string;

  constructor(agentName: string, trigger: WebhookTrigger, orchestrator: Orchestrator) {
    this.agentName = agentName;
    this.trigger = trigger;
    this.orchestrator = orchestrator;
    this.path = trigger.path ?? `/api/triggers/webhooks/${agentName}`;
  }

  register(fastify: FastifyInstance): void {
    fastify.post(this.path, async (request, reply) => {
      try {
        const body = (request.body as Record<string, unknown>) ?? {};
        const input = { ...this.trigger.input, ...body };
        const sessionId = `trigger-${this.agentName}-webhook-${Date.now()}`;

        log.info(`Webhook invoked for agent "${this.agentName}" at ${this.path}`);
        const result = await this.orchestrator.runAgent(this.agentName, input, sessionId);

        return reply.send(result);
      } catch (error) {
        log.error(`Webhook failed for agent "${this.agentName}":`, error);
        return reply.status(500).send({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    log.info(`Registered webhook for agent "${this.agentName}" at POST ${this.path}`);
  }
}
