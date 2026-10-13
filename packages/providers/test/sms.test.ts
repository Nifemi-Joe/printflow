import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { BackgroundSms, CaptureSms, TermiiSms, type SmsSender } from "../src/sms.js";

const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

/** A local stand-in for Termii's /api/sms/send that records requests. */
async function fakeTermii(reply: (body: Record<string, unknown>) => { status: number; json: unknown }) {
  const seen: Array<{ path: string; body: Record<string, unknown>; contentType: string | undefined }> = [];
  const server = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      seen.push({ path: req.url ?? "", body, contentType: req.headers["content-type"] });
      const r = reply(body);
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.json));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

describe("TermiiSms", () => {
  it("posts the documented fields and accepts a message id", async () => {
    const t = await fakeTermii(() => ({ status: 200, json: { message_id: "9122821270554876574", message: "Successfully Sent", balance: 9, user: "Test" } }));
    const sms = new TermiiSms({ apiKey: "TLkey", senderId: "PrintFlow", baseUrl: t.url, channel: "dnd" });
    await sms.send({ to: "+2348031234567", text: "Your PrintFlow verification code is 123456." });
    expect(t.seen[0]).toMatchObject({
      path: "/api/sms/send",
      contentType: "application/json",
      body: { api_key: "TLkey", to: "2348031234567", from: "PrintFlow", sms: "Your PrintFlow verification code is 123456.", type: "plain", channel: "dnd" },
    });
  });

  it("treats rejections as failures without leaking the key or text", async () => {
    const t = await fakeTermii(() => ({ status: 400, json: { message: "Insufficient balance" } }));
    const sms = new TermiiSms({ apiKey: "TLsecret", senderId: "PrintFlow", baseUrl: t.url, channel: "dnd" });
    const err = await sms.send({ to: "+2348031234567", text: "code 654321" }).catch((e: Error) => e);
    expect(String(err)).toMatch(/400: Insufficient balance/);
    expect(String(err)).not.toMatch(/TLsecret|654321/);
    const noId = await fakeTermii(() => ({ status: 200, json: { message: "queued?" } }));
    await expect(new TermiiSms({ apiKey: "k", senderId: "PrintFlow", baseUrl: noId.url, channel: "generic" }).send({ to: "+2348031234567", text: "x" })).rejects.toThrow();
  });

  it("refuses a plain-http gateway outside localhost", () => {
    expect(() => new TermiiSms({ apiKey: "k", senderId: "PrintFlow", baseUrl: "http://api.example.com", channel: "dnd" })).toThrow(/https/);
  });
});

describe("BackgroundSms", () => {
  it("returns immediately, retries, and never logs the message text", async () => {
    const lines: string[] = [];
    let calls = 0;
    const flaky: SmsSender = {
      name: "flaky",
      async send() {
        calls++;
        throw new Error("gateway down");
      },
    };
    const bg = new BackgroundSms(flaky, pino({ level: "warn" }, { write: (l: string) => void lines.push(l) }), 3, 1);
    const t0 = Date.now();
    await bg.send({ to: "+2348031234567", text: "code 112233" });
    expect(Date.now() - t0).toBeLessThan(50);
    await bg.flush();
    expect(calls).toBe(3);
    expect(lines.join("")).toContain("sms delivery failed");
    expect(lines.join("")).not.toContain("112233");
  });

  it("capture driver exposes the last code for tests", async () => {
    const c = new CaptureSms();
    await c.send({ to: "+2348031234567", text: "Your code is 908172. It expires in 10 minutes." });
    expect(c.lastCode("+2348031234567")).toBe("908172");
  });
});
