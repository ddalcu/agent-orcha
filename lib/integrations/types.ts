import { z } from 'zod';

const CollabnookIntegrationSchema = z.object({
  type: z.literal('collabnook'),
  url: z.string(),
  channel: z.string(),
  botName: z.string(),
  password: z.string().optional(),
  replyDelay: z.number().optional(),
});

const EmailIntegrationSchema = z.object({
  type: z.literal('email'),
  imap: z.object({
    host: z.string(),
    port: z.number().default(993),
    secure: z.boolean().default(true),
  }),
  smtp: z.object({
    host: z.string(),
    port: z.number().default(587),
    secure: z.boolean().default(false),
  }),
  auth: z.object({
    user: z.string(),
    pass: z.string(),
  }).optional(),
  fromName: z.string().optional(),
  fromAddress: z.string().optional(),
  polling: z.boolean().default(true),
  pollInterval: z.number().default(60),
  folder: z.string().default('INBOX'),
});

// Add new types to this union as needed (slack, whatsapp, etc.)
export const IntegrationSchema = z.discriminatedUnion('type', [
  CollabnookIntegrationSchema,
  EmailIntegrationSchema,
]);

export type Integration = z.infer<typeof IntegrationSchema>;
export type CollabnookIntegration = z.infer<typeof CollabnookIntegrationSchema>;
export type EmailIntegration = z.infer<typeof EmailIntegrationSchema>;

export interface IntegrationAccessor {
  getChannelContext: (agentName: string) => string;
  getChannelMembers: (agentName: string) => Array<{ userId: string; name: string }>;
  postMessage: (agentName: string, message: string) => void;
  sendEmail: (agentName: string, to: string, subject: string, body: string) => Promise<void>;
  hasEmailIntegration: (agentName: string) => boolean;
  hasChannelIntegration: (agentName: string) => boolean;
}
