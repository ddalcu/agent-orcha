import { z } from 'zod';

const CronTriggerSchema = z.object({
  type: z.literal('cron'),
  schedule: z.string(),
  input: z.record(z.unknown()).default({}),
});

const WebhookTriggerSchema = z.object({
  type: z.literal('webhook'),
  path: z.string().optional(),
  input: z.record(z.unknown()).default({}),
});

export const TriggerSchema = z.discriminatedUnion('type', [
  CronTriggerSchema,
  WebhookTriggerSchema,
]);

export type Trigger = z.infer<typeof TriggerSchema>;
export type CronTrigger = z.infer<typeof CronTriggerSchema>;
export type WebhookTrigger = z.infer<typeof WebhookTriggerSchema>;
