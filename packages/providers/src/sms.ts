import type { Logger } from "pino";
import { devConsole, extractCode, extractLinks } from "./dev-console.js";

export interface SmsMessage {
  /** E.164, e.g. +2348012345678 */
  to: string;
  text: string;
}

/**
 * SMS delivery boundary. TERMII sends through Termii's messaging API (a
 * Nigerian SMS gateway); LOG prints messages for development; CAPTURE keeps them
 * in memory for tests; NONE drops them (phone features are then unavailable).
 */
export interface SmsSender {
  readonly name: string;
  send(msg: SmsMessage): Promise<void>;
}

export class SmsDeliveryError extends Error {
  override readonly name = "SmsDeliveryError";
}

export interface TermiiOptions {
  apiKey: string;
  /** Approved sender ID (alphanumeric, up to 11 characters) or a Termii number. */
  senderId: string;
  /** Account base URL from the Termii dashboard, e.g. https://api.ng.termii.com */
  baseUrl: string;
  /** "dnd" reaches numbers on Do-Not-Disturb (needed for codes); "generic" does not. */
  channel: "dnd" | "generic";
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class TermiiSms implements SmsSender {
  readonly name = "termii";
  constructor(private readonly o: TermiiOptions) {
    if (!/^https:\/\//.test(o.baseUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o.baseUrl)) {
      throw new Error("TERMII_BASE_URL must be https");
    }
  }

  async send(msg: SmsMessage): Promise<void> {
    const f = this.o.fetchImpl ?? fetch;
    const res = await f(`${this.o.baseUrl.replace(/\/$/, "")}/api/sms/send`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        api_key: this.o.apiKey,
        // Termii expects the number without the leading +.
        to: msg.to.replace(/^\+/, ""),
        from: this.o.senderId,
        sms: msg.text,
        type: "plain",
        channel: this.o.channel,
      }),
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000),
    });
    let body: { message_id?: string; message?: string } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      /* non-JSON error page */
    }
    if (!res.ok || !body.message_id) {
      // Never include the API key or message text in errors.
      throw new SmsDeliveryError(`termii rejected the message (${res.status}${body.message ? `: ${String(body.message).slice(0, 120)}` : ""})`);
    }
  }
}

/**
 * Development driver: nothing is sent. The text goes to the log (at warn, so it shows
 * with quiet log levels) and the code to the terminal as a readable box.
 * Configuration refuses this driver in production.
 */
export class LogSms implements SmsSender {
  readonly name = "log";
  constructor(
    private readonly log: Logger,
    private readonly printToTerminal = true,
  ) {}
  async send(msg: SmsMessage): Promise<void> {
    this.log.warn({ sms: { to: msg.to, text: msg.text } }, "sms (LOG driver, not delivered)");
    if (!this.printToTerminal) return;
    const code = extractCode(msg.text);
    const links = extractLinks(msg.text);
    devConsole(code ? "SMS code (not sent)" : "SMS (not sent)", [
      { label: "To", value: msg.to },
      ...(code ? [{ label: "Code", value: code }] : []),
      ...links.map((l) => ({ label: "Link", value: l })),
      { label: "Text", value: msg.text },
    ]);
  }
}

export class CaptureSms implements SmsSender {
  readonly name = "capture";
  readonly sent: SmsMessage[] = [];
  async send(msg: SmsMessage): Promise<void> {
    this.sent.push(msg);
  }
  last(to: string): SmsMessage | undefined {
    return [...this.sent].reverse().find((m) => m.to === to);
  }
  /** The most recent 6-digit code sent to a number. */
  lastCode(to: string): string | undefined {
    return /\b(\d{6})\b/.exec(this.last(to)?.text ?? "")?.[1];
  }
}

export class NoneSms implements SmsSender {
  readonly name = "none";
  async send(): Promise<void> {}
}

/**
 * Sends in the background with retries, so request handlers neither wait on the
 * gateway nor reveal (through timing or errors) whether a number has an account.
 * Failures are logged without the message text, which may contain a code.
 */
export class BackgroundSms implements SmsSender {
  readonly name: string;
  private pending = new Set<Promise<void>>();
  constructor(
    private readonly inner: SmsSender,
    private readonly log: Logger,
    private readonly attempts = 3,
    private readonly backoffMs = 2_000,
  ) {
    this.name = inner.name;
  }
  async send(msg: SmsMessage): Promise<void> {
    const p = this.deliver(msg).finally(() => this.pending.delete(p));
    this.pending.add(p);
  }
  private async deliver(msg: SmsMessage): Promise<void> {
    for (let i = 1; i <= this.attempts; i++) {
      try {
        await this.inner.send(msg);
        return;
      } catch (e) {
        const last = i === this.attempts;
        this.log[last ? "error" : "warn"]({ err: { message: (e as Error).message }, attempt: i }, last ? "sms delivery failed" : "sms delivery retry");
        if (!last) await new Promise((r) => setTimeout(r, this.backoffMs * i));
      }
    }
  }
  async flush(): Promise<void> {
    await Promise.all([...this.pending]);
  }
}
