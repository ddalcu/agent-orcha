import { CollabnookConnector, type ChannelMember } from './collabnook.ts';
import { EmailConnector } from './email.ts';
import { createLogger } from '../logger.ts';
import type { Orchestrator } from '../orchestrator.ts';
import type { AgentDefinition } from '../agents/types.ts';
import type { CollabnookIntegration, EmailIntegration } from './types.ts';

const log = createLogger('IntegrationManager');

interface Connector {
  connect(): Promise<void>;
  close(): void;
  getRecentMessages(): string;
  getChannelMembers(): ChannelMember[];
  postMessage(text: string): void;
}

export class IntegrationManager {
  private connectors: Map<string, Connector[]> = new Map();

  async start(orchestrator: Orchestrator): Promise<void> {
    const agents = orchestrator.agents.list();

    for (const agent of agents) {
      if (!agent.integrations || agent.integrations.length === 0) continue;

      for (const integration of agent.integrations) {
        if (integration.type === 'collabnook') {
          await this.startCollabnook(orchestrator, agent, integration);
        } else if (integration.type === 'email') {
          await this.startEmail(orchestrator, agent, integration);
        }
      }
    }

    const total = this.connectorCount;
    if (total > 0) {
      log.info(`Started ${total} integration connector(s)`);
    }
  }

  getChannelContext(agentName: string): string {
    const agentConnectors = this.connectors.get(agentName);
    if (!agentConnectors || agentConnectors.length === 0) return '';

    return agentConnectors.map(c => c.getRecentMessages()).filter(Boolean).join('\n');
  }

  getChannelMembers(agentName: string): ChannelMember[] {
    const agentConnectors = this.connectors.get(agentName);
    if (!agentConnectors || agentConnectors.length === 0) return [];

    // Merge members from all connectors, dedup by userId
    const seen = new Set<string>();
    const members: ChannelMember[] = [];
    for (const connector of agentConnectors) {
      for (const member of connector.getChannelMembers()) {
        if (!seen.has(member.userId)) {
          seen.add(member.userId);
          members.push(member);
        }
      }
    }
    return members;
  }

  postMessage(agentName: string, message: string): void {
    const agentConnectors = this.connectors.get(agentName);
    if (!agentConnectors || agentConnectors.length === 0) return;

    for (const connector of agentConnectors) {
      connector.postMessage(message);
    }
  }

  async sendEmail(agentName: string, to: string, subject: string, body: string): Promise<void> {
    const agentConnectors = this.connectors.get(agentName);
    if (!agentConnectors) return;

    for (const connector of agentConnectors) {
      if (connector instanceof EmailConnector) {
        await connector.sendEmail(to, subject, body);
      }
    }
  }

  hasEmailIntegration(agentName: string): boolean {
    const agentConnectors = this.connectors.get(agentName);
    if (!agentConnectors) return false;
    return agentConnectors.some(c => c instanceof EmailConnector);
  }

  hasChannelIntegration(agentName: string): boolean {
    const agentConnectors = this.connectors.get(agentName);
    if (!agentConnectors) return false;
    return agentConnectors.some(c => c instanceof CollabnookConnector);
  }

  async syncAgent(orchestrator: Orchestrator, agentName: string): Promise<void> {
    const existing = this.connectors.get(agentName);
    if (existing) {
      for (const c of existing) c.close();
      this.connectors.delete(agentName);
    }

    const agent = orchestrator.agents.get(agentName);
    if (!agent?.integrations) return;

    for (const integration of agent.integrations) {
      if (integration.type === 'collabnook') {
        await this.startCollabnook(orchestrator, agent, integration);
      } else if (integration.type === 'email') {
        await this.startEmail(orchestrator, agent, integration);
      }
    }
  }

  close(): void {
    for (const agentConnectors of this.connectors.values()) {
      for (const connector of agentConnectors) {
        connector.close();
      }
    }
    this.connectors.clear();
  }

  private get connectorCount(): number {
    let count = 0;
    for (const agentConnectors of this.connectors.values()) {
      count += agentConnectors.length;
    }
    return count;
  }

  private addConnector(agentName: string, connector: Connector): void {
    const existing = this.connectors.get(agentName) ?? [];
    existing.push(connector);
    this.connectors.set(agentName, existing);
  }

  private async startCollabnook(
    orchestrator: Orchestrator,
    agent: AgentDefinition,
    config: CollabnookIntegration,
  ): Promise<void> {
    const inputVar = agent.prompt.inputVariables[0] || 'query';
    const sessionId = `integration-${agent.name}-${config.channel}`;

    const onCommand = async (command: string, requesterName: string): Promise<string> => {
      const members = connector.getChannelMembers();
      const memberList = members.map(m => m.name).join(', ');
      const input: Record<string, unknown> = {
        [inputVar]: `Request from ${requesterName}: ${command}`,
      };
      if (memberList) {
        input.channelMembers = memberList;
      }
      const result = await orchestrator.runAgent(agent.name, input, sessionId);
      return typeof result.output === 'string'
        ? result.output
        : JSON.stringify(result.output);
    };

    const connector = new CollabnookConnector(config, agent.name, onCommand);
    await connector.connect();
    this.addConnector(agent.name, connector);

    log.info(`Connected agent "${agent.name}" to CollabNook channel #${config.channel}`);
  }

  private async startEmail(
    orchestrator: Orchestrator,
    agent: AgentDefinition,
    config: EmailIntegration,
  ): Promise<void> {
    const inputVar = agent.prompt.inputVariables[0] || 'query';

    const onCommand = async (body: string, senderEmail: string, meta: { subject: string; from: string }): Promise<string> => {
      const sessionId = `integration-${agent.name}-email-${senderEmail}`;
      const input: Record<string, unknown> = {
        [inputVar]: `Email from ${meta.from} (${senderEmail}):\nSubject: ${meta.subject}\n\n${body}`,
      };
      const result = await orchestrator.runAgent(agent.name, input, sessionId);
      return typeof result.output === 'string'
        ? result.output
        : JSON.stringify(result.output);
    };

    const connector = new EmailConnector(config, agent.name, onCommand);
    await connector.connect();
    this.addConnector(agent.name, connector);

    const identity = config.auth?.user ?? config.fromAddress ?? config.imap.host;
    log.info(`Connected agent "${agent.name}" to email ${identity} (folder: ${config.folder})`);
  }
}
