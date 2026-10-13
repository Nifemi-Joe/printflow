import type { AddressInfo } from "node:net";
import pino from "pino";
import { SMTPServer } from "smtp-server";
import { afterEach, describe, expect, it } from "vitest";
import { BackgroundMailer, smtpTransportOptions, SmtpMailer, type Mailer } from "../src/mailer.js";

interface Received {
  from: string;
  to: string[];
  raw: string;
  user: string | undefined;
}

const servers: SMTPServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

/** A real SMTP server (no TLS) listening on a random local port. */
async function startServer(opts: { auth?: boolean; starttls?: boolean } = {}) {
  const received: Received[] = [];
  const server = new SMTPServer({
    authOptional: !opts.auth,
    allowInsecureAuth: true,
    disabledCommands: opts.starttls ? [] : ["STARTTLS"],
    logger: false,
    onAuth(auth, _session, cb) {
      if (auth.username === "mailer" && auth.password === "p@ss word") cb(null, { user: auth.username });
      else cb(new Error("bad credentials"));
    },
    onData(stream, session, cb) {
      let raw = "";
      stream.on("data", (c: Buffer) => (raw += c.toString("utf8")));
      stream.on("end", () => {
        received.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "",
          to: session.envelope.rcptTo.map((r) => r.address),
          raw,
          user: session.user as string | undefined,
        });
        cb();
      });
    },
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.server.address() as AddressInfo).port;
  return { port, received };
}

describe("SmtpMailer", () => {
  it("delivers a plain-text message with authentication", async () => {
    const { port, received } = await startServer({ auth: true });
    const m = new SmtpMailer({ url: `smtp://mailer:${encodeURIComponent("p@ss word")}@127.0.0.1:${port}`, from: "PrintFlow <no-reply@example.test>", requireTls: false });
    await m.send({ to: "student@example.test", subject: "Confirm your PrintFlow email", text: "Confirm: https://printflow.example/verify-email?token=abc" });
    m.close();
    expect(received).toHaveLength(1);
    expect(received[0]!.from).toBe("no-reply@example.test");
    expect(received[0]!.to).toEqual(["student@example.test"]);
    expect(received[0]!.user).toBe("mailer");
    expect(received[0]!.raw).toMatch(/^Subject: Confirm your PrintFlow email\r?$/m);
    expect(received[0]!.raw).toContain("verify-email?token=abc");
  });

  it("cannot be used to inject headers through the subject", async () => {
    const { port, received } = await startServer();
    const m = new SmtpMailer({ url: `smtp://127.0.0.1:${port}`, from: "no-reply@example.test", requireTls: false });
    await m.send({ to: "a@example.test", subject: "Hello\r\nBcc: attacker@example.test", text: "x" });
    m.close();
    expect(received[0]!.to).toEqual(["a@example.test"]);
    expect(received[0]!.raw).not.toMatch(/^Bcc:/im);
  });

  it("refuses to send in plaintext when TLS is required and the server offers none", async () => {
    const { port, received } = await startServer();
    const m = new SmtpMailer({ url: `smtp://127.0.0.1:${port}`, from: "no-reply@example.test", requireTls: true });
    await expect(m.send({ to: "a@example.test", subject: "s", text: "t" })).rejects.toThrow();
    m.close();
    expect(received).toHaveLength(0);
  });

  it("rejects bad credentials", async () => {
    const { port } = await startServer({ auth: true });
    const m = new SmtpMailer({ url: `smtp://mailer:wrong@127.0.0.1:${port}`, from: "no-reply@example.test", requireTls: false });
    await expect(m.send({ to: "a@example.test", subject: "s", text: "t" })).rejects.toThrow();
    m.close();
  });

  it("parses connection URLs and refuses other schemes", () => {
    expect(smtpTransportOptions({ url: "smtps://u:p@mail.example:465", from: "x", requireTls: true })).toMatchObject({ host: "mail.example", port: 465, secure: true, requireTLS: false });
    expect(smtpTransportOptions({ url: "smtp://mail.example", from: "x", requireTls: true })).toMatchObject({ port: 587, secure: false, requireTLS: true });
    expect(() => smtpTransportOptions({ url: "https://mail.example", from: "x", requireTls: true })).toThrow(/smtp/);
  });
});

describe("BackgroundMailer", () => {
  const silent = pino({ level: "silent" });

  it("returns immediately and retries until delivery succeeds", async () => {
    let calls = 0;
    const delivered: string[] = [];
    const flaky: Mailer = {
      async send(msg) {
        calls++;
        if (calls < 3) throw new Error("relay unavailable");
        delivered.push(msg.to);
      },
    };
    const bg = new BackgroundMailer(flaky, silent, 3, 1);
    const started = Date.now();
    await bg.send({ to: "a@example.test", subject: "s", text: "t" });
    expect(Date.now() - started).toBeLessThan(50);
    await bg.flush();
    expect(calls).toBe(3);
    expect(delivered).toEqual(["a@example.test"]);
  });

  it("never rejects to the caller and logs the failure without the body", async () => {
    const lines: string[] = [];
    const log = pino({ level: "warn" }, { write: (l: string) => void lines.push(l) });
    const broken: Mailer = {
      async send() {
        throw new Error("relay unavailable");
      },
    };
    const bg = new BackgroundMailer(broken, log, 2, 1);
    await expect(bg.send({ to: "a@example.test", subject: "Reset your password", text: "secret-reset-link" })).resolves.toBeUndefined();
    await bg.flush();
    expect(lines.some((l) => l.includes("email delivery failed"))).toBe(true);
    expect(lines.join("")).not.toContain("secret-reset-link");
  });
});
