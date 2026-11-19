export interface EmailMessage {
  to: string;
  subject: string;
  textBody: string;
}

export interface EmailNotificationAdapter {
  send(message: EmailMessage): Promise<void>;
}

/**
 * Safe default adapter for academic evaluation & local development.
 * Never depends on an external SMTP server; stores metadata-only envelopes in memory.
 */
export class InMemoryDevEmailAdapter implements EmailNotificationAdapter {
  readonly sentLog: Array<{ to: string; subject: string; queuedAt: string }> = [];

  async send(message: EmailMessage): Promise<void> {
    if (this.sentLog.length >= 200) {
      this.sentLog.shift();
    }
    this.sentLog.push({
      to: message.to,
      subject: message.subject,
      queuedAt: new Date().toISOString(),
    });
  }
}
