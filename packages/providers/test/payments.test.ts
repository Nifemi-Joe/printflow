import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeChannel, PaystackProvider, TestPaymentProvider } from "../src/payments.js";

const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

/** Local stand-in for api.paystack.co that records requests. */
async function fakePaystack() {
  const seen: Array<{ path: string; auth: string | undefined; body: Record<string, unknown> }> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ path: req.url ?? "", auth: req.headers.authorization, body: JSON.parse(raw || "{}") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: true, message: "Authorization URL created", data: { authorization_url: "https://checkout.paystack.com/abc123", access_code: "abc123", reference: "pf_x" } }));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

describe("Paystack checkout channels", () => {
  it("limits the hosted checkout to the chosen method", async () => {
    const f = await fakePaystack();
    const p = new PaystackProvider("sk_test_x", f.url);
    const r = await p.initialize({ reference: "pf_1", amountKobo: 15_150, email: "a@b.co", callbackUrl: "https://web/student/orders/1", channels: ["BANK_TRANSFER"] });
    expect(r.checkoutUrl).toBe("https://checkout.paystack.com/abc123");
    expect(f.seen[0]).toMatchObject({
      path: "/transaction/initialize",
      auth: "Bearer sk_test_x",
      body: { reference: "pf_1", amount: 15_150, currency: "NGN", email: "a@b.co", channels: ["bank_transfer"] },
    });
    await p.initialize({ reference: "pf_2", amountKobo: 100, email: "a@b.co", callbackUrl: "x", channels: ["CARD", "BANK_TRANSFER", "USSD"] });
    expect(f.seen[1]!.body.channels).toEqual(["card", "bank_transfer", "ussd"]);
  });

  it("maps provider channel names", () => {
    expect(normalizeChannel("bank_transfer")).toBe("BANK_TRANSFER");
    expect(normalizeChannel("dedicated_nuban")).toBe("BANK_TRANSFER");
    expect(normalizeChannel("USSD")).toBe("USSD");
    expect(normalizeChannel("card")).toBe("CARD");
    expect(normalizeChannel("apple_pay")).toBe("OTHER");
    expect(normalizeChannel(undefined)).toBeNull();
  });

  it("the test provider passes a single chosen method to its checkout page", async () => {
    const t = new TestPaymentProvider("http://web.test/", "s");
    expect((await t.initialize({ reference: "pf_9", channels: ["USSD"] })).checkoutUrl).toBe("http://web.test/checkout/test/pf_9?method=USSD");
    expect((await t.initialize({ reference: "pf_9", channels: ["CARD", "USSD"] })).checkoutUrl).toBe("http://web.test/checkout/test/pf_9");
  });
});
