export function naira(kobo: number | string | null | undefined): string {
  const k = Number(kobo ?? 0);
  if (!Number.isFinite(k)) return "—";
  const negative = k < 0;
  const abs = Math.abs(Math.round(k));
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}₦${whole}.${(abs % 100).toString().padStart(2, "0")}`;
}

export function when(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("en-NG", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function relative(iso: string | Date): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return when(iso);
}

export const STATUS_LABEL: Record<string, string> = {
  AWAITING_PAYMENT: "Awaiting payment",
  PAID: "Paid, waiting for the shop",
  ACCEPTED: "Accepted",
  REJECTED: "Rejected by shop",
  PRINTING: "Printing",
  PAUSED: "Paused",
  PRINT_FAILED: "Print problem",
  QUALITY_CHECK: "Quality check",
  READY_FOR_PICKUP: "Ready for pickup",
  COLLECTED: "Collected",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
  REFUND_PENDING: "Refund in progress",
  REFUNDED: "Refunded",
};

export function statusTone(status: string): "go" | "warn" | "bad" | "plain" {
  if (["READY_FOR_PICKUP", "COLLECTED", "READY", "APPROVED", "SUCCEEDED", "AVAILABLE"].includes(status)) return "go";
  if (["PAUSED", "PRINT_FAILED", "REFUND_PENDING", "PENDING_APPROVAL", "AWAITING_PAYMENT", "PENDING", "PROCESSING", "OUT_OF_PAPER", "OUT_OF_TONER", "BUSY"].includes(status)) return "warn";
  if (["REJECTED", "CANCELLED", "EXPIRED", "FAILED", "SUSPENDED", "REMOVED", "INFECTED", "FAULT", "OFFLINE"].includes(status)) return "bad";
  return "plain";
}

export const SPEC_LABEL = {
  BW: "Black & white",
  COLOUR: "Colour",
  SINGLE: "Single-sided",
  DOUBLE: "Double-sided",
} as Record<string, string>;

/** "2:00 pm" in Lagos time, for "back at" messages. */
export function clock(iso: string | Date): string {
  return new Date(iso).toLocaleTimeString("en-NG", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Africa/Lagos" }).replace(" ", "\u00a0");
}

export const METHOD_LABEL: Record<string, string> = {
  CARD: "Card",
  BANK_TRANSFER: "Bank transfer",
  USSD: "USSD",
  BANK: "Bank account",
  QR: "QR code",
  MOBILE_MONEY: "Mobile money",
  OTHER: "Other",
};
