/** Staff-facing names for each order transition, and whether a reason is required. */
export function actionLabel(from: string, to: string): { label: string; needsReason: boolean; tone: "primary" | "quiet" | "danger" } {
  switch (to) {
    case "ACCEPTED":
      return { label: "Accept", needsReason: false, tone: "primary" };
    case "REJECTED":
      return { label: "Reject and refund", needsReason: true, tone: "danger" };
    case "PRINTING":
      return { label: from === "PAUSED" ? "Resume" : from === "PRINT_FAILED" ? "Try printing again" : from === "QUALITY_CHECK" ? "Reprint" : "Start printing", needsReason: from === "QUALITY_CHECK", tone: "primary" };
    case "PAUSED":
      return { label: "Pause", needsReason: true, tone: "quiet" };
    case "PRINT_FAILED":
      return { label: "Report a problem", needsReason: true, tone: "danger" };
    case "QUALITY_CHECK":
      return { label: "Send to quality check", needsReason: false, tone: "primary" };
    case "REFUND_PENDING":
      return { label: "Cancel and refund", needsReason: true, tone: "danger" };
    default:
      return { label: to, needsReason: false, tone: "quiet" };
  }
}

export interface Draft {
  clientActionId: string;
  orderId: string;
  reference: string;
  to: string;
  expectedVersion: number;
  reason?: string;
  draftedAt: string;
}

const key = (shopId: string) => `pf-shop-drafts-${shopId}`;

/** Actions recorded while offline. They live only on this device until the server confirms them. */
export function loadDrafts(shopId: string): Draft[] {
  try {
    return JSON.parse(localStorage.getItem(key(shopId)) ?? "[]") as Draft[];
  } catch {
    return [];
  }
}

export function saveDrafts(shopId: string, drafts: Draft[]) {
  try {
    localStorage.setItem(key(shopId), JSON.stringify(drafts));
  } catch {
    /* storage unavailable: drafts stay in memory only */
  }
}
