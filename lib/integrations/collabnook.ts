import WebSocket from 'ws';
import { createLogger } from '../logger.ts';
import type { CollabnookIntegration } from './types.ts';

const RECONNECT_DELAY = 3000;
const MAX_MESSAGE_LOG_CHARS = 4000;

export interface ChannelMember {
  userId: string;
  name: string;
}

type OnCommand = (command: string, requesterName: string) => Promise<string>;

export class CollabnookConnector {
  private config: CollabnookIntegration;
  private agentName: string;
  private onCommand: OnCommand;
  private log;

  private ws: WebSocket | null = null;
  private userId: string | null = null;
  private sessionId: string | null = null;
  private targetChannelId: string | null = null;
  private pendingCreate = false;
  private busy = false;
  private taskQueue: Array<{ command: string; requesterName: string }> = [];
  private closed = false;
  private nameSuffix = 0;
  private messageLog: string[] = [];
  private messageLogChars = 0;
  private members: Map<string, string> = new Map(); // name → userId

  constructor(
    config: CollabnookIntegration,
    agentName: string,
    onCommand: OnCommand,
  ) {
    this.config = config;
    this.agentName = agentName;
    this.onCommand = onCommand;
    this.log = createLogger(`CollabnookConnector:${agentName}`);
  }

  connect(): Promise<void> {
    return new Promise((resolve) => {
      this.doConnect(resolve);
    });
  }

  close(): void {
    this.closed = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  postMessage(text: string): void {
    this.sendChat(text);
  }

  getRecentMessages(): string {
    return this.messageLog.join('\n');
  }

  getChannelMembers(): ChannelMember[] {
    return Array.from(this.members.entries()).map(([name, userId]) => ({ userId, name }));
  }

  private doConnect(onFirstOpen?: () => void): void {
    if (this.closed) return;

    this.log.info(`Connecting to ${this.config.url}...`);
    const ws = new WebSocket(this.config.url);

    ws.on('open', () => {
      this.log.info('Connected');
      this.ws = ws;
      this.send({ type: 'init', sessionId: this.sessionId });
      if (onFirstOpen) {
        onFirstOpen();
        onFirstOpen = undefined;
      }
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString());
        this.dispatch(msg);
      } catch (err) {
        this.log.error('Failed to parse message:', err);
      }
    });

    ws.on('close', () => {
      this.ws = null;
      if (!this.closed) {
        this.log.info(`Disconnected. Reconnecting in ${RECONNECT_DELAY}ms...`);
        setTimeout(() => this.doConnect(), RECONNECT_DELAY);
      }
    });

    ws.on('error', (err: Error) => {
      this.log.error('WebSocket error:', err.message);
    });
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private sendChat(text: string): void {
    const mentions = this.resolveMentions(text);
    const msg: Record<string, unknown> = { type: 'chat', text };
    if (mentions.length > 0) {
      msg.mentions = mentions;
    }
    this.send(msg);
  }

  /**
   * Scan text for @username patterns and resolve them to userIds
   * using the known channel members.
   */
  private resolveMentions(text: string): Array<{ userId: string }> {
    const seen = new Set<string>();
    const mentions: Array<{ userId: string }> = [];

    for (const match of text.matchAll(/@([\w-]+)/g)) {
      const name = match[1]!;
      if (seen.has(name)) continue;
      seen.add(name);

      const userId = this.members.get(name);
      if (userId) {
        mentions.push({ userId });
      }
    }

    return mentions;
  }

  private dispatch(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'welcome': return this.handleWelcome(msg);
      case 'error': return this.handleError(msg);
      case 'channel-list': return this.handleChannelList(msg);
      case 'channel-joined': return this.handleChannelJoined(msg);
      case 'chat': return this.handleChat(msg);
      case 'user-joined': return this.handleUserJoined(msg);
      case 'user-left': return this.handleUserLeft(msg);
      case 'user-list': return this.handleUserList(msg);
    }
  }

  private handleWelcome(msg: Record<string, unknown>): void {
    this.userId = msg.userId as string;
    this.sessionId = msg.sessionId as string;
    this.nameSuffix = 0;
    this.log.info(`Welcome! userId=${this.userId}`);
    this.send({ type: 'set-name', name: this.config.botName });
    this.send({ type: 'set-bot-info', botType: this.agentName });
  }

  private handleError(msg: Record<string, unknown>): void {
    if (msg.code === 'NAME_TAKEN') {
      this.nameSuffix++;
      const newName = `${this.config.botName}-${this.nameSuffix}`;
      this.log.info(`Name "${this.config.botName}" taken, retrying as "${newName}"`);
      this.send({ type: 'set-name', name: newName });
    }
  }

  private handleChannelList(msg: Record<string, unknown>): void {
    if (this.targetChannelId) return;

    const channels = msg.channels as Array<{ id: string; name: string }>;
    const target = channels.find(
      c => c.name.toLowerCase() === this.config.channel.toLowerCase()
    );

    if (!target) {
      if (this.pendingCreate) return;
      this.pendingCreate = true;

      this.log.info(`Channel "${this.config.channel}" not found, creating it...`);
      const createMsg: Record<string, unknown> = {
        type: 'create-channel',
        name: this.config.channel,
        channelType: this.config.password ? 'private' : 'public',
      };
      if (this.config.password) {
        createMsg.password = this.config.password;
      }
      this.send(createMsg);
      return;
    }

    this.targetChannelId = target.id;
    const joinMsg: Record<string, unknown> = { type: 'join-channel', channelId: target.id };
    if (this.config.password) {
      joinMsg.password = this.config.password;
    }
    this.send(joinMsg);
    this.send({ type: 'switch-channel', channelId: target.id });
    this.send({ type: 'get-users' });
    this.log.info(`Joining channel: #${target.name}`);
  }

  private handleChannelJoined(msg: Record<string, unknown>): void {
    this.log.info(`Joined #${msg.channelName}`);

    if (this.pendingCreate && !this.targetChannelId) {
      this.targetChannelId = msg.channelId as string;
      this.pendingCreate = false;
      this.send({ type: 'switch-channel', channelId: this.targetChannelId });
      this.send({ type: 'get-users' });
      this.log.info(`Created and joined channel #${msg.channelName}`);
    }

    // Populate members from the join response if available
    const users = msg.users as Array<{ id: string; name: string }> | undefined;
    if (users) {
      for (const user of users) {
        this.members.set(user.name, user.id);
      }
    }
  }

  private handleUserJoined(msg: Record<string, unknown>): void {
    const name = msg.name as string;
    const userId = msg.userId as string;
    if (name && userId) {
      this.members.set(name, userId);
    }
  }

  private handleUserLeft(msg: Record<string, unknown>): void {
    const name = msg.name as string;
    if (name) {
      this.members.delete(name);
    }
  }

  private handleUserList(msg: Record<string, unknown>): void {
    const users = msg.users as Array<{ id: string; name: string }> | undefined;
    if (!users) return;
    for (const user of users) {
      if (user.name && user.id) {
        this.members.set(user.name, user.id);
      }
    }
    this.log.info(`Channel members: ${Array.from(this.members.keys()).join(', ')}`);
  }

  private logMessage(name: string, text: string): void {
    const line = `[${name}]: ${text}`;
    this.messageLog.push(line);
    this.messageLogChars += line.length + 1; // +1 for newline

    while (this.messageLogChars > MAX_MESSAGE_LOG_CHARS && this.messageLog.length > 1) {
      const removed = this.messageLog.shift()!;
      this.messageLogChars -= removed.length + 1;
    }
  }

  private handleChat(msg: Record<string, unknown>): void {
    const senderName = msg.name as string;
    const senderId = msg.userId as string;
    const text = msg.text as string;

    // Track all senders as channel members
    if (senderName && senderId) {
      this.members.set(senderName, senderId);
    }

    // Log all messages (including bot's own) for channel context
    this.logMessage(senderName, text);

    if (senderId === this.userId) return;

    const mentions = msg.mentions as Array<{ userId: string }> | undefined;
    if (!mentions || !mentions.some(m => m.userId === this.userId)) return;

    const command = text.replace(/@[\w-]+/g, '').trim();
    if (!command) {
      this.sendChat('What would you like me to do?');
      return;
    }

    this.enqueue(command, msg.name as string);
  }

  private enqueue(command: string, requesterName: string): void {
    if (this.busy) {
      this.taskQueue.push({ command, requesterName });
      this.sendChat(`Queued (${this.taskQueue.length} ahead). Working on another task.`);
      return;
    }
    this.executeTask(command, requesterName);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async executeTask(command: string, requesterName: string): Promise<void> {
    this.busy = true;
    const startTime = Date.now();
    this.log.info(`Task from ${requesterName}: ${command}`);

    if (this.config.replyDelay) {
      await this.delay(this.config.replyDelay);
    }

    try {
      const result = await this.onCommand(command, requesterName);

      for (const chunk of this.splitMessage(result, 7500)) {
        this.sendChat(chunk);
      }
    } catch (err) {
      const duration = this.formatDuration(Date.now() - startTime);
      const message = err instanceof Error ? err.message : String(err);
      this.log.error('Task failed:', message);
      this.sendChat(`**Task failed** — ${message} (${duration})`);
    }

    this.busy = false;
    this.processNext();
  }

  private processNext(): void {
    if (this.taskQueue.length === 0) return;
    const remaining = this.taskQueue.length;
    const next = this.taskQueue.shift()!;
    this.sendChat(`Processing next task (${remaining - 1} remaining in queue)...`);
    this.executeTask(next.command, next.requesterName);
  }

  private splitMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += maxLen) {
      chunks.push(text.slice(i, i + maxLen));
    }
    return chunks;
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const secs = Math.floor(ms / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    const remSecs = secs % 60;
    return `${mins}m ${remSecs}s`;
  }
}
