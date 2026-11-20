import nodemailer, { Transporter } from 'nodemailer';
import { EmailMessage, EmailSender } from '../domain/auth-group-module.js';

export interface SmtpMailerConfig {
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  pass?: string;
  from?: string;
}

export class SmtpEmailSender implements EmailSender {
  private readonly host: string;
  private readonly from: string;
  private readonly transporter: Transporter | null;

  constructor(config: SmtpMailerConfig = {}) {
    this.host = (config.host ?? process.env.SMTP_HOST ?? '').trim();
    const rawPort = config.port ?? Number.parseInt(process.env.SMTP_PORT ?? '587', 10);
    const port = Number.isFinite(rawPort) && rawPort > 0 ? rawPort : 587;
    const rawSecure = process.env.SMTP_SECURE?.trim().toLowerCase();
    const secure =
      config.secure !== undefined
        ? config.secure
        : rawSecure === 'true'
          ? true
          : rawSecure === 'false'
            ? false
            : port === 465;

    const user = (config.user ?? process.env.SMTP_USER ?? '').trim();
    const pass = config.pass ?? process.env.SMTP_PASS ?? '';
    const configuredFrom = (config.from ?? process.env.SMTP_FROM ?? '').trim();
    this.from = configuredFrom || user || 'LovedOnes <noreply@localhost>';

    if (!this.host) {
      this.transporter = null;
      return;
    }

    this.transporter = nodemailer.createTransport({
      host: this.host,
      port,
      secure,
      ...(user ? { auth: { user, pass } } : {}),
    });
  }

  isConfigured(): boolean {
    return Boolean(this.transporter && this.host);
  }

  async sendMail(msg: EmailMessage): Promise<void> {
    if (!this.transporter) {
      throw new Error('SMTP_HOST is not configured');
    }
    await this.transporter.sendMail({
      from: this.from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      ...(msg.html ? { html: msg.html } : {}),
    });
  }
}
