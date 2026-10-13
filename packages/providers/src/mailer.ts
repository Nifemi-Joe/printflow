import nodemailer, { type Transporter } from "nodemailer";
import type { Logger } from "pino";
import { devConsole, extractLinks } from "./dev-console.js";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * Email delivery boundary. SMTP delivers through any SMTP relay (a transactional
 * provider's SMTP endpoint or your own server); LOG writes the message to the
 * structured log (development), CAPTURE keeps it in memory (tests), NONE drops it.
 */
export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

/**
 * Development driver: nothing is sent. The message goes to the structured log and,
 * so links are easy to click while testing, to the terminal as a readable box.
 * Configuration refuses this driver in production.
 */
export class LogMailer implements Mailer {
  constructor(
    private readonly log: Logger,
    private readonly printToTerminal = true,
  ) {}
  async send(msg: MailMessage): Promise<void> {
    this.log.info({ mail: { to: msg.to, subject: msg.subject, text: msg.text } }, "email (LOG driver, not delivered)");
    if (!this.printToTerminal) return;
    const links = extractLinks(msg.text);
    devConsole("email (not sent)", [
      { label: "To", value: msg.to },
      { label: "Subject", value: msg.subject },
      ...links.map((l, i) => ({ label: links.length > 1 ? `Link ${i + 1}` : "Link", value: l })),
      ...(links.length === 0 ? msg.text.split("\n").map((t) => ({ label: "", value: t })) : []),
    ]);
  }
}

export class CaptureMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  async send(msg: MailMessage): Promise<void> {
    this.sent.push(msg);
  }
  last(to: string): MailMessage | undefined {
    return [...this.sent].reverse().find((m) => m.to === to);
  }
}

export class NoneMailer implements Mailer {
  async send(): Promise<void> {}
}

export interface SmtpOptions {
  /** smtp://user:pass@host:587 (STARTTLS) or smtps://user:pass@host:465 (implicit TLS). */
  url: string;
  from: string;
  /** Refuse to send unless the connection is encrypted. Only tests and local relays turn this off. */
  requireTls: boolean;
}

export function smtpTransportOptions(o: SmtpOptions) {
  const u = new URL(o.url);
  if (u.protocol !== "smtp:" && u.protocol !== "smtps:") throw new Error("SMTP_URL must start with smtp:// or smtps://");
  const implicitTls = u.protocol === "smtps:";
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : implicitTls ? 465 : 587,
    secure: implicitTls,
    requireTLS: o.requireTls && !implicitTls,
    auth: u.username ? { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) } : undefined,
    tls: { minVersion: "TLSv1.2" as const },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  };
}

export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;
  constructor(private readonly opts: SmtpOptions) {
    this.transport = nodemailer.createTransport(smtpTransportOptions(opts));
  }
  async send(msg: MailMessage): Promise<void> {
    // Plain text only; nodemailer encodes headers, and CR/LF are stripped from the subject defensively.
    await this.transport.sendMail({ from: this.opts.from, to: msg.to, subject: msg.subject.replace(/[\r\n]+/g, " "), text: msg.text });
  }
  close(): void {
    this.transport.close();
  }
}

/**
 * Wraps a mailer so request handlers never wait on (or fail because of) the
 * mail relay. Used by the API for account emails: an awaited send would let
 * response time or errors reveal whether an account exists. Delivery is retried
 * a few times in-process; failures are logged without the message body, which
 * can contain one-time links.
 */
export class BackgroundMailer implements Mailer {
  private pending = new Set<Promise<void>>();
  constructor(
    private readonly inner: Mailer,
    private readonly log: Logger,
    private readonly attempts = 3,
    private readonly backoffMs = 2_000,
  ) {}
  async send(msg: MailMessage): Promise<void> {
    const p = this.deliver(msg).finally(() => this.pending.delete(p));
    this.pending.add(p);
  }
  private async deliver(msg: MailMessage): Promise<void> {
    for (let i = 1; i <= this.attempts; i++) {
      try {
        await this.inner.send(msg);
        return;
      } catch (e) {
        const last = i === this.attempts;
        this.log[last ? "error" : "warn"]({ err: { message: (e as Error).message }, subject: msg.subject, attempt: i }, last ? "email delivery failed" : "email delivery retry");
        if (!last) await new Promise((r) => setTimeout(r, this.backoffMs * i));
      }
    }
  }
  /** Resolves when queued messages have been attempted (graceful shutdown, tests). */
  async flush(): Promise<void> {
    await Promise.all([...this.pending]);
  }
}
