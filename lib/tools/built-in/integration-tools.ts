import { tool } from '../../types/tool-factory.ts';
import { z } from 'zod';
import type { StructuredTool } from '../../types/llm-types.ts';
import type { IntegrationAccessor } from '../../integrations/types.ts';

export function createIntegrationTools(
  accessor: IntegrationAccessor,
  agentName: string,
): StructuredTool[] {
  const tools: StructuredTool[] = [];
  const hasChannel = accessor.hasChannelIntegration(agentName);
  const hasEmail = accessor.hasEmailIntegration(agentName);

  if (hasChannel) {
    tools.push(tool(
      async ({ message }) => {
        accessor.postMessage(agentName, message);
        return 'Message posted to integration channel successfully.';
      },
      {
        name: 'integration_post',
        description:
          'Post a message to your integration channel. ' +
          'Use this when asked to report, share, or send information to your channel.',
        schema: z.object({
          message: z.string().describe('The message to post to the integration channel'),
        }),
      },
    ));
  }

  if (hasChannel || hasEmail) {
    tools.push(tool(
      async () => {
        const context = accessor.getChannelContext(agentName);
        return context || 'No recent messages.';
      },
      {
        name: 'integration_context',
        description:
          'Get recent messages or emails from your integration. ' +
          'Use this to understand the current conversation context.',
        schema: z.object({}),
      },
    ));
  }

  if (hasEmail) {
    tools.push(tool(
      async ({ to, subject, body }) => {
        await accessor.sendEmail(agentName, to, subject, body);
        return `Email sent to ${to} with subject "${subject}".`;
      },
      {
        name: 'email_send',
        description:
          'Send an email to a recipient. Use this to compose and send emails.',
        schema: z.object({
          to: z.string().describe('Recipient email address'),
          subject: z.string().describe('Email subject line'),
          body: z.string().describe('Email body text'),
        }),
      },
    ));
  }

  return tools;
}
