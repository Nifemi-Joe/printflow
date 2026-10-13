/** Same identity as the web app: emerald, graphite, paper. */
export const C = {
  emerald: "#0a7a55",
  emeraldDeep: "#05402d",
  emeraldWash: "#e4f2ec",
  graphite: "#24292e",
  graphite2: "#5a6168",
  paper: "#f5f7f4",
  sheet: "#ffffff",
  rule: "#d6dbd5",
  amber: "#9a5b00",
  amberWash: "#fdf1dc",
  red: "#b42318",
  redWash: "#fdecea",
};

export const F = {
  display: "BricolageGrotesque_700Bold",
  displayHeavy: "BricolageGrotesque_800ExtraBold",
  body: "AtkinsonHyperlegible_400Regular",
  bodyBold: "AtkinsonHyperlegible_700Bold",
};

export const S = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };

export function naira(kobo: number | string | null | undefined): string {
  const k = Math.round(Number(kobo ?? 0));
  const abs = Math.abs(k);
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${k < 0 ? "-" : ""}₦${whole}.${String(abs % 100).padStart(2, "0")}`;
}

export function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-NG", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
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

export const METHOD_LABEL: Record<string, string> = {
  CARD: "Card",
  BANK_TRANSFER: "Bank transfer",
  USSD: "USSD",
  BANK: "Bank account",
  QR: "QR code",
  MOBILE_MONEY: "Mobile money",
  OTHER: "Other",
};

export const METHOD_HINT: Record<string, string> = {
  CARD: "Debit card (Verve, Mastercard, Visa)",
  BANK_TRANSFER: "Transfer from any bank app to a one-time account",
  USSD: "Dial a code. No data or app needed",
};

/** "7:00 pm" in Lagos time. */
export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-NG", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Africa/Lagos" });
}

export interface Power {
  status: "UNKNOWN" | "GRID" | "GENERATOR" | "OUTAGE";
  label: string;
  canPrint: boolean | null;
  backAt: string | null;
  overdue: boolean;
  note: string | null;
  updatedAt: string | null;
  stale: boolean;
  updatedBy?: string | null;
}

/** "Light out, back about 2:00 pm" — one line a student reads at a glance. */
export function powerSummary(p: Power): string {
  if (p.status === "OUTAGE") {
    if (p.backAt && !p.overdue) return `Light out, back about ${clock(p.backAt)}`;
    if (p.backAt && p.overdue) return `Light out (expected back ${clock(p.backAt)})`;
    return "Light out";
  }
  return p.label;
}
