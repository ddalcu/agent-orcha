import { CollabnookConnector, type ChannelMember } from './collabnook.js';
import { createLogger } from '../logger.js';
import type { Orchestrator } from '../orchestrator.js';
import type { AgentDefinition } from '../agents/types.js';
import type { CollabnookIntegration } from './types.js';

const log = createLogger('IntegrationManager');

export class IntegrationManager {
  private connectors: Map<string, CollabnookConnector[]> = new Map();

  async start(orchestrator: Orchestrator): Promise<void> {
    const agents = orchestrator.agents.list();

    for (const agent of agents) {
      if (!agent.integrations || agent.integrations.length === 0) continue;

      for (const integration of agent.integrations) {
        if (integration.type === 'collabnook') {
          await this.startCollabnook(orchestrator, agent, integration);
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

    const existing = this.connectors.get(agent.name) ?? [];
    existing.push(connector);
    this.connectors.set(agent.name, existing);

    log.info(`Connected agent "${agent.name}" to CollabNook channel #${config.channel}`);
  }
}
