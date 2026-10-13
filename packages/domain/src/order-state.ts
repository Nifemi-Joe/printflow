/**
 * The order lifecycle. This map is the single source of truth: the API checks it
 * before writing, and the database trigger in migration 0003 enforces the same
 * table (a test asserts they are identical).
 */
export const ORDER_STATUSES = [
  "AWAITING_PAYMENT",
  "PAID",
  "ACCEPTED",
  "REJECTED",
  "PRINTING",
  "PAUSED",
  "PRINT_FAILED",
  "QUALITY_CHECK",
  "READY_FOR_PICKUP",
  "COLLECTED",
  "CANCELLED",
  "EXPIRED",
  "REFUND_PENDING",
  "REFUNDED",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ACTOR_KINDS = ["STUDENT", "SHOP_STAFF", "UNIVERSITY_ADMIN", "PLATFORM_ADMIN", "SYSTEM"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/** Granular shop permissions held by a staff membership. */
export const SHOP_PERMISSIONS = [
  "orders.view",
  "orders.accept",
  "orders.produce",
  "orders.qa",
  "orders.collect",
  "documents.download",
  "devices.manage",
  "catalogue.manage",
  "pricing.manage",
  "staff.manage",
  "reports.view",
] as const;
export type ShopPermission = (typeof SHOP_PERMISSIONS)[number];

/** Default permission sets per shop role. Owners can adjust individual staff. */
export const ROLE_DEFAULT_PERMISSIONS: Record<"OWNER" | "MANAGER" | "OPERATOR", readonly ShopPermission[]> = {
  OWNER: SHOP_PERMISSIONS,
  MANAGER: [
    "orders.view",
    "orders.accept",
    "orders.produce",
    "orders.qa",
    "orders.collect",
    "documents.download",
    "devices.manage",
    "catalogue.manage",
    "reports.view",
  ],
  OPERATOR: ["orders.view", "orders.produce", "orders.qa", "orders.collect", "documents.download"],
};

export interface Transition {
  from: OrderStatus;
  to: OrderStatus;
  /** Who may trigger it. */
  actors: readonly ActorKind[];
  /** For SHOP_STAFF, the permission required. */
  permission?: ShopPermission;
  /** True when the caller must supply a reason (rejections, failures, refunds). */
  requiresReason?: boolean;
}

export const ORDER_TRANSITIONS: readonly Transition[] = [
  // Payment
  { from: "AWAITING_PAYMENT", to: "PAID", actors: ["SYSTEM"] },
  { from: "AWAITING_PAYMENT", to: "CANCELLED", actors: ["STUDENT", "SYSTEM"] },
  { from: "AWAITING_PAYMENT", to: "EXPIRED", actors: ["SYSTEM"] },

  // Shop intake
  { from: "PAID", to: "ACCEPTED", actors: ["SHOP_STAFF"], permission: "orders.accept" },
  { from: "PAID", to: "REJECTED", actors: ["SHOP_STAFF"], permission: "orders.accept", requiresReason: true },
  // Cancellation is only eligible before the shop accepts; money must be returned.
  { from: "PAID", to: "REFUND_PENDING", actors: ["STUDENT", "UNIVERSITY_ADMIN", "PLATFORM_ADMIN"], requiresReason: true },
  { from: "REJECTED", to: "REFUND_PENDING", actors: ["SYSTEM"] },

  // Production
  { from: "ACCEPTED", to: "PRINTING", actors: ["SHOP_STAFF"], permission: "orders.produce" },
  { from: "PRINTING", to: "PAUSED", actors: ["SHOP_STAFF"], permission: "orders.produce", requiresReason: true },
  { from: "PAUSED", to: "PRINTING", actors: ["SHOP_STAFF"], permission: "orders.produce" },
  { from: "PRINTING", to: "PRINT_FAILED", actors: ["SHOP_STAFF"], permission: "orders.produce", requiresReason: true },
  { from: "PAUSED", to: "PRINT_FAILED", actors: ["SHOP_STAFF"], permission: "orders.produce", requiresReason: true },
  { from: "PRINT_FAILED", to: "PRINTING", actors: ["SHOP_STAFF"], permission: "orders.produce" },
  {
    from: "PRINT_FAILED",
    to: "REFUND_PENDING",
    actors: ["SHOP_STAFF", "UNIVERSITY_ADMIN", "PLATFORM_ADMIN"],
    permission: "orders.produce",
    requiresReason: true,
  },
  { from: "PRINTING", to: "QUALITY_CHECK", actors: ["SHOP_STAFF"], permission: "orders.produce" },

  // Quality assurance
  { from: "QUALITY_CHECK", to: "READY_FOR_PICKUP", actors: ["SHOP_STAFF"], permission: "orders.qa" },
  { from: "QUALITY_CHECK", to: "PRINTING", actors: ["SHOP_STAFF"], permission: "orders.qa", requiresReason: true },

  // Collection (pickup code verified in the same transaction)
  { from: "READY_FOR_PICKUP", to: "COLLECTED", actors: ["SHOP_STAFF"], permission: "orders.collect" },

  // Refund settlement is confirmed by the payment provider only.
  { from: "REFUND_PENDING", to: "REFUNDED", actors: ["SYSTEM"] },
];

export const TERMINAL_STATUSES: readonly OrderStatus[] = ["COLLECTED", "CANCELLED", "EXPIRED", "REFUNDED"];

/** Statuses in which an order occupies a place in the shop's work queue. */
export const QUEUED_STATUSES: readonly OrderStatus[] = ["PAID", "ACCEPTED", "PRINTING", "PAUSED", "PRINT_FAILED", "QUALITY_CHECK"];

export class TransitionError extends Error {
  override readonly name = "TransitionError";
  constructor(
    message: string,
    readonly code: "INVALID_TRANSITION" | "FORBIDDEN_ACTOR" | "MISSING_PERMISSION" | "REASON_REQUIRED",
  ) {
    super(message);
  }
}

export interface TransitionRequest {
  from: OrderStatus;
  to: OrderStatus;
  actor: ActorKind;
  /** Permissions held by the acting staff member at this order's shop. */
  permissions?: readonly ShopPermission[];
  reason?: string;
}

export function findTransition(from: OrderStatus, to: OrderStatus): Transition | undefined {
  return ORDER_TRANSITIONS.find((t) => t.from === from && t.to === to);
}

/** Throws unless the transition is allowed for this actor. Returns the rule applied. */
export function assertTransition(req: TransitionRequest): Transition {
  const t = findTransition(req.from, req.to);
  if (!t) throw new TransitionError(`cannot move an order from ${req.from} to ${req.to}`, "INVALID_TRANSITION");
  if (!t.actors.includes(req.actor)) {
    throw new TransitionError(`${req.actor} may not move an order from ${req.from} to ${req.to}`, "FORBIDDEN_ACTOR");
  }
  if (req.actor === "SHOP_STAFF" && t.permission && !(req.permissions ?? []).includes(t.permission)) {
    throw new TransitionError(`requires shop permission ${t.permission}`, "MISSING_PERMISSION");
  }
  if (t.requiresReason && !(req.reason && req.reason.trim().length >= 3)) {
    throw new TransitionError("a reason is required for this action", "REASON_REQUIRED");
  }
  return t;
}

export function allowedNextStatuses(from: OrderStatus, actor: ActorKind, permissions: readonly ShopPermission[] = []): OrderStatus[] {
  return ORDER_TRANSITIONS.filter(
    (t) =>
      t.from === from &&
      t.actors.includes(actor) &&
      (actor !== "SHOP_STAFF" || !t.permission || permissions.includes(t.permission)),
  ).map((t) => t.to);
}

/** Students may cancel only before a shop has accepted the job. */
export function cancellationEligibility(status: OrderStatus): "CANCEL_NO_CHARGE" | "CANCEL_WITH_REFUND" | "NOT_ELIGIBLE" {
  if (status === "AWAITING_PAYMENT") return "CANCEL_NO_CHARGE";
  if (status === "PAID") return "CANCEL_WITH_REFUND";
  return "NOT_ELIGIBLE";
}

/** Human-readable labels for clients. */
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  AWAITING_PAYMENT: "Awaiting payment",
  PAID: "Paid — waiting for the shop",
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
