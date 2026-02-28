import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { createLogger } from '../logger.ts';
import type { EmailIntegration } from './types.ts';
import type { ChannelMember } from './collabnook.ts';

const MAX_MESSAGE_LOG_CHARS = 4000;

export interface EmailMeta {
  subject: string;
  from: string;
  messageId: string;
}

type OnCommand = (body: string, senderEmail: string, meta: EmailMeta) => Promise<string>;

export class EmailConnector {
  private config: EmailIntegration;
  private onCommand: OnCommand;
  private log;

  private smtp: Transporter | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private closed = false;
  private busy = false;
  private taskQueue: Array<{ body: string; senderEmail: string; meta: EmailMeta }> = [];
  private messageLog: string[] = [];
  private messageLogChars = 0;
  private senders: Map<string, string> = new Map(); // email → display name

  constructor(config: EmailIntegration, agentName: string, onCommand: OnCommand) {
    this.config = config;
    this.onCommand = onCommand;
    this.log = createLogger(`EmailConnector:${agentName}`);
  }

  async connect(): Promise<void> {
    if (this.config.imap.port === 993 && !this.config.imap.secure) {
      this.log.warn('Port 993 typically requires secure: true (IMAPS). Connection may hang. Use port 143 for non-secure.');
    }

    const smtpOptions: Record<string, unknown> = {
      host: this.config.smtp.host,
      port: this.config.smtp.port,
      secure: this.config.smtp.secure,
    };
    if (this.config.auth) {
      smtpOptions.auth = { user: this.config.auth.user, pass: this.config.auth.pass };
    }
    this.smtp = nodemailer.createTransport(smtpOptions);

    if (this.config.polling) {
      const intervalMs = this.config.pollInterval * 1000;
      this.pollTimer = setInterval(() => this.poll(), intervalMs);
      this.log.info(`Polling ${this.config.folder} every ${this.config.pollInterval}s`);
      this.poll().catch(() => {});
    } else {
      this.log.info('IMAP polling disabled — send-only mode');
    }
  }

  close(): void {
    this.closed = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.smtp) {
      this.smtp.close();
      this.smtp = null;
    }
  }

  async sendEmail(to: string, subject: string, body: string, inReplyTo?: string): Promise<void> {
    if (!this.smtp) return;

    const address = this.config.fromAddress ?? this.config.auth?.user ?? 'agent@localhost';
    const from = this.config.fromName
      ? `"${this.config.fromName}" <${address}>`
      : address;

    const mailOptions: Record<string, unknown> = {
      from,
      to,
      subject,
      text: body,
    };
    if (inReplyTo) {
      mailOptions.inReplyTo = inReplyTo;
      mailOptions.references = inReplyTo;
    }

    await this.smtp.sendMail(mailOptions);
    this.log.info(`Sent email to ${to}: ${subject}`);
  }

  postMessage(_text: string): void {
    // No-op for email — use sendEmail with explicit recipient
  }

  getRecentMessages(): string {
    return this.messageLog.join('\n');
  }

  getChannelMembers(): ChannelMember[] {
    return Array.from(this.senders.entries()).map(([email, name]) => ({
      userId: email,
      name: name || email,
    }));
  }

  private async poll(): Promise<void> {
    if (this.closed || this.polling) return;
    this.polling = true;
    this.log.info(`Polling ${this.config.folder}...`);

    let imap: ImapFlow | null = null;
    try {
      const imapOptions: Record<string, unknown> = {
        host: this.config.imap.host,
        port: this.config.imap.port,
        secure: this.config.imap.secure,
        logger: false,
        connectionTimeout: 15_000,
        socketTimeout: 30_000,
      };
      if (this.config.auth) {
        imapOptions.auth = { user: this.config.auth.user, pass: this.config.auth.pass };
      }
      imap = new ImapFlow(imapOptions as any);
      imap.on('error', (err: Error) => {
        this.log.warn(`IMAP error: ${err.message}`);
      });

      this.log.info(`Connecting to ${this.config.imap.host}:${this.config.imap.port} (secure: ${this.config.imap.secure})...`);
      await imap.connect();
      this.log.info('IMAP connected');

      const lock = await imap.getMailboxLock(this.config.folder);
      try {
        // Step 1: Search for unseen UIDs (separate command)
        const searchResult = await imap.search({ seen: false }, { uid: true });
        const uids = Array.isArray(searchResult) ? searchResult : [];

        if (uids.length === 0) {
          this.log.info(`Checked ${this.config.folder} — no new emails`);
          return;
        }

        // Step 2: Fetch messages by UID range
        const pending: Array<{ uid: number; body: string; senderEmail: string; meta: EmailMeta }> = [];
        for await (const msg of imap.fetch(uids, { uid: true, envelope: true, source: true })) {
          const envelope = msg.envelope;
          if (!envelope) continue;

          const fromAddr = envelope.from?.[0];
          const senderEmail = fromAddr?.address || 'unknown';
          const senderName = fromAddr?.name || senderEmail;
          const subject = envelope.subject || '(no subject)';
          const messageId = envelope.messageId || '';

          if (!msg.source) continue;
          const body = this.extractTextBody(msg.source);

          this.senders.set(senderEmail, senderName);
          this.logMessage(senderName, subject, body);
          pending.push({ uid: msg.uid, body, senderEmail, meta: { subject, from: senderName, messageId } });
        }

        // Step 3: Mark all fetched messages as seen (after fetch completes)
        if (pending.length > 0) {
          const fetchedUids = pending.map(p => p.uid);
          await imap.messageFlagsAdd(fetchedUids, ['\\Seen'], { uid: true });

          const senderSet = new Set(pending.map(p => p.senderEmail));
          const senders = Array.from(senderSet).join(', ');
          this.log.info(`Found ${pending.length} new email(s) from ${senderSet.size} sender(s): ${senders}`);
        }

        // Step 4: Enqueue for agent processing
        for (const item of pending) {
          this.enqueue(item.body, item.senderEmail, item.meta);
        }
      } finally {
        lock.release();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`Poll failed: ${message}`);
    } finally {
      if (imap) {
        try { await imap.logout(); } catch { imap.close(); }
      }
      this.polling = false;
    }
  }

  private extractTextBody(source: Buffer): string {
    const raw = source.toString('utf-8');

    const headerEnd = raw.indexOf('\r\n\r\n');
    if (headerEnd === -1) return raw;

    const headers = raw.slice(0, headerEnd).toLowerCase();
    const bodyPart = raw.slice(headerEnd + 4);

    const boundaryMatch = headers.match(/boundary="?([^";\r\n]+)"?/);
    if (boundaryMatch) {
      const boundary = boundaryMatch[1]!;
      const parts = bodyPart.split(`--${boundary}`);
      for (const part of parts) {
        if (part.toLowerCase().includes('content-type: text/plain')) {
          const partBodyStart = part.indexOf('\r\n\r\n');
          if (partBodyStart !== -1) {
            return this.decodeBody(part.slice(partBodyStart + 4).trim(), part);
          }
        }
      }
    }

    return this.decodeBody(bodyPart.trim(), headers);
  }

  private decodeBody(body: string, headers: string): string {
    const lowerHeaders = headers.toLowerCase();
    if (lowerHeaders.includes('content-transfer-encoding: base64')) {
      return Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf-8');
    }
    if (lowerHeaders.includes('content-transfer-encoding: quoted-printable')) {
      return body
        .replace(/=\r?\n/g, '')
        .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    }
    return body;
  }

  private logMessage(sender: string, subject: string, body: string): void {
    const preview = body.length > 200 ? body.slice(0, 200) + '...' : body;
    const line = `[${sender}] ${subject}: ${preview}`;
    this.messageLog.push(line);
    this.messageLogChars += line.length + 1;

    while (this.messageLogChars > MAX_MESSAGE_LOG_CHARS && this.messageLog.length > 1) {
      const removed = this.messageLog.shift()!;
      this.messageLogChars -= removed.length + 1;
    }
  }

  private enqueue(body: string, senderEmail: string, meta: EmailMeta): void {
    if (this.busy) {
      this.taskQueue.push({ body, senderEmail, meta });
      this.log.info(`Queued email from ${senderEmail} (${this.taskQueue.length} in queue)`);
      return;
    }
    this.executeTask(body, senderEmail, meta);
  }

  private async executeTask(body: string, senderEmail: string, meta: EmailMeta): Promise<void> {
    this.busy = true;
    this.log.info(`Processing email from ${senderEmail}: ${meta.subject}`);

    try {
      const result = await this.onCommand(body, senderEmail, meta);

      const replySubject = meta.subject.startsWith('Re:') ? meta.subject : `Re: ${meta.subject}`;
      await this.sendEmail(senderEmail, replySubject, result, meta.messageId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`Failed to process email from ${senderEmail}: ${message}`);
    }

    this.busy = false;
    this.processNext();
  }

  private processNext(): void {
    if (this.taskQueue.length === 0) return;
    const next = this.taskQueue.shift()!;
    this.log.info(`Processing next email (${this.taskQueue.length} remaining)`);
    this.executeTask(next.body, next.senderEmail, next.meta);
  }
}
