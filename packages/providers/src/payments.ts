import { createHmac, randomUUID } from "node:crypto";

/** Checkout methods students can choose. Paystack calls these "channels". */
export const PAYMENT_METHODS = ["CARD", "BANK_TRANSFER", "USSD"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

const PAYSTACK_CHANNEL: Record<PaymentMethod, string> = { CARD: "card", BANK_TRANSFER: "bank_transfer", USSD: "ussd" };

export interface InitializeResult {
  /** Where to send the payer. */
  checkoutUrl: string;
}

/**
 * Payment provider boundary. The order's frozen total is the only amount ever
 * sent; nothing here computes prices.
 */
export interface PaymentProvider {
  readonly name: "PAYSTACK" | "TEST";
  /** `channels` limits the hosted checkout to the methods offered (and, if the student chose one, to that one). */
  initialize(params: { reference: string; amountKobo: number; email: string; callbackUrl: string; channels: readonly PaymentMethod[] }): Promise<InitializeResult>;
  /** Requests a refund; returns the provider's refund reference. Completion arrives by webhook. */
  refund(params: { transactionReference: string; amountKobo: number }): Promise<{ providerRefundReference: string }>;
}

export class ProviderError extends Error {
  override readonly name = "ProviderError";
}

/**
 * Paystack (https://paystack.com/docs/api). Implemented against the documented
 * API but NOT exercised against Paystack from this environment: no account or
 * keys were available and outbound network to api.paystack.co is blocked here.
 */
export class PaystackProvider implements PaymentProvider {
  readonly name = "PAYSTACK" as const;
  constructor(
    private readonly secretKey: string,
    private readonly baseUrl = "https://api.paystack.co",
  ) {}

  private async call<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.secretKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as { status?: boolean; message?: string; data?: T };
    if (!res.ok || !json.status || !json.data) throw new ProviderError(`Paystack ${path} failed: ${json.message ?? res.status}`);
    return json.data;
  }

  async initialize(p: { reference: string; amountKobo: number; email: string; callbackUrl: string; channels: readonly PaymentMethod[] }): Promise<InitializeResult> {
    const data = await this.call<{ authorization_url: string }>("/transaction/initialize", {
      reference: p.reference,
      amount: p.amountKobo,
      currency: "NGN",
      email: p.email,
      callback_url: p.callbackUrl,
      channels: p.channels.map((c) => PAYSTACK_CHANNEL[c]),
    });
    return { checkoutUrl: data.authorization_url };
  }

  async refund(p: { transactionReference: string; amountKobo: number }): Promise<{ providerRefundReference: string }> {
    const data = await this.call<{ id: number }>("/refund", { transaction: p.transactionReference, amount: p.amountKobo });
    return { providerRefundReference: String(data.id) };
  }

  /** Looks up a transaction's final state (used by reconciliation for missed webhooks). */
  async verify(reference: string): Promise<{ status: string; amountKobo: number; currency: string; id: string }> {
    const res = await fetch(`${this.baseUrl}/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${this.secretKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as { status?: boolean; message?: string; data?: { status: string; amount: number; currency: string; id: number } };
    if (!res.ok || !json.status || !json.data) throw new ProviderError(`Paystack verify failed: ${json.message ?? res.status}`);
    return { status: json.data.status, amountKobo: json.data.amount, currency: json.data.currency, id: String(json.data.id) };
  }
}

/**
 * Simulated provider for development and automated tests. Its "webhooks" are
 * HMAC-signed with TEST_WEBHOOK_SECRET and go through the same verification and
 * processing path as real ones. Configuration refuses it in production.
 */
export class TestPaymentProvider implements PaymentProvider {
  readonly name = "TEST" as const;
  constructor(
    private readonly webUrl: string,
    private readonly webhookSecret: string,
  ) {}

  async initialize(p: { reference: string; channels: readonly PaymentMethod[] }): Promise<InitializeResult> {
    const only = p.channels.length === 1 ? `?method=${p.channels[0]}` : "";
    return { checkoutUrl: `${this.webUrl.replace(/\/$/, "")}/checkout/test/${encodeURIComponent(p.reference)}${only}` };
  }

  async refund(): Promise<{ providerRefundReference: string }> {
    return { providerRefundReference: `test_rf_${randomUUID()}` };
  }

  sign(rawBody: Buffer): string {
    return createHmac("sha512", this.webhookSecret).update(rawBody).digest("hex");
  }
}

/** Maps a provider's channel name (e.g. Paystack "bank_transfer") to ours. */
export function normalizeChannel(raw: unknown): "CARD" | "BANK_TRANSFER" | "USSD" | "BANK" | "QR" | "MOBILE_MONEY" | "OTHER" | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  switch (raw.toLowerCase()) {
    case "card":
      return "CARD";
    case "bank_transfer":
    case "dedicated_nuban":
      return "BANK_TRANSFER";
    case "ussd":
      return "USSD";
    case "bank":
      return "BANK";
    case "qr":
      return "QR";
    case "mobile_money":
      return "MOBILE_MONEY";
    default:
      return "OTHER";
  }
}

export const CHANNEL_LABELS: Record<string, string> = {
  CARD: "Card",
  BANK_TRANSFER: "Bank transfer",
  USSD: "USSD",
  BANK: "Bank account",
  QR: "QR code",
  MOBILE_MONEY: "Mobile money",
  OTHER: "Other",
};
