import { z } from 'zod';

const CollabnookIntegrationSchema = z.object({
  type: z.literal('collabnook'),
  url: z.string(),
  channel: z.string(),
  botName: z.string(),
  password: z.string().optional(),
});

// Add new types to this union as needed (slack, whatsapp, etc.)
export const IntegrationSchema = z.discriminatedUnion('type', [
  CollabnookIntegrationSchema,
]);

export type Integration = z.infer<typeof IntegrationSchema>;
export type CollabnookIntegration = z.infer<typeof CollabnookIntegrationSchema>;
