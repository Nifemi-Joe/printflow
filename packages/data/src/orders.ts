import {
  assertTransition,
  type ActorKind,
  type OrderStatus,
  type ShopPermission,
  QUEUED_STATUSES,
  TransitionError,
} from "../../domain/src/index.js";
import { ConflictError, NotFoundError, RuleViolationError } from "./errors.js";
import type { Queryable } from "./tx.js";

/**
 * Tenant scope of the caller. Every lookup is filtered by it, so an order outside
 * the caller's scope is indistinguishable from one that does not exist (no IDOR
 * oracle). SYSTEM callers pass { kind: "SYSTEM" }.
 */
export type OrderScope =
  | { kind: "STUDENT"; studentUserId: string }
  | { kind: "SHOP"; shopId: string }
  | { kind: "UNIVERSITY"; universityId: string }
  | { kind: "PLATFORM" }
  | { kind: "SYSTEM" };

export interface OrderRow {
  id: string;
  reference: string;
  university_id: string;
  shop_id: string;
  student_user_id: string;
  status: OrderStatus;
  row_version: number;
  total_kobo: string;
}

const ORDER_COLUMNS = "id, reference, university_id, shop_id, student_user_id, status, row_version, total_kobo";

export function scopeFilter(scope: OrderScope, firstParam: number, alias = ""): { sql: string; params: unknown[] } {
  const p = alias ? `${alias}.` : "";
  switch (scope.kind) {
    case "STUDENT":
      return { sql: `AND ${p}student_user_id = $${firstParam}`, params: [scope.studentUserId] };
    case "SHOP":
      // Shops never see an order until it has been paid.
      return { sql: `AND ${p}shop_id = $${firstParam} AND ${p}status <> 'AWAITING_PAYMENT'`, params: [scope.shopId] };
    case "UNIVERSITY":
      return { sql: `AND ${p}university_id = $${firstParam}`, params: [scope.universityId] };
    case "PLATFORM":
    case "SYSTEM":
      return { sql: "", params: [] };
  }
}

export async function lockOrder(db: Queryable, orderId: string, scope: OrderScope): Promise<OrderRow> {
  const f = scopeFilter(scope, 2);
  const { rows } = await db.query<OrderRow>(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1 ${f.sql} FOR UPDATE`, [orderId, ...f.params]);
  const row = rows[0];
  if (!row) throw new NotFoundError("order not found");
  return row;
}

export function actorForScope(scope: OrderScope): ActorKind {
  switch (scope.kind) {
    case "STUDENT":
      return "STUDENT";
    case "SHOP":
      return "SHOP_STAFF";
    case "UNIVERSITY":
      return "UNIVERSITY_ADMIN";
    case "PLATFORM":
      return "PLATFORM_ADMIN";
    case "SYSTEM":
      return "SYSTEM";
  }
}

export interface TransitionInput {
  orderId: string;
  to: OrderStatus;
  scope: OrderScope;
  actorUserId: string | null;
  /** Staff permissions at this order's shop (resolved by the caller from shop_memberships). */
  permissions?: readonly ShopPermission[];
  reason?: string;
  /** Optimistic concurrency: reject if the order has moved on since the client loaded it. */
  expectedVersion?: number;
  deviceId?: string;
  requestId?: string;
}

/** Student-facing notifications emitted on status changes. */
const STUDENT_NOTICES: Partial<Record<OrderStatus, { title: string; body: string }>> = {
  PAID: { title: "Payment received", body: "Your payment was confirmed and your job is in the shop's queue." },
  ACCEPTED: { title: "Order accepted", body: "The print shop has accepted your job." },
  REJECTED: { title: "Order rejected", body: "The shop could not take your job. A full refund has been started." },
  PRINTING: { title: "Printing started", body: "Your document is being printed." },
  PRINT_FAILED: { title: "Printing problem", body: "The shop reported a problem with your job and is working on it." },
  READY_FOR_PICKUP: { title: "Ready for pickup", body: "Your prints are ready. Show your pickup code at the counter." },
  COLLECTED: { title: "Collected", body: "Your order was collected. Thank you for using PrintFlow." },
  EXPIRED: { title: "Order expired", body: "Payment was not completed in time, so the order expired." },
  REFUND_PENDING: { title: "Refund started", body: "A refund for this order is being processed." },
  REFUNDED: { title: "Refund completed", body: "Your refund has been completed by the payment provider." },
};

/**
 * The only function that changes an order's status. Must run inside a transaction.
 * Domain rules are checked here; the database trigger re-checks the transition
 * table as defence in depth.
 */
export async function transitionOrder(db: Queryable, input: TransitionInput): Promise<OrderRow> {
  const order = await lockOrder(db, input.orderId, input.scope);
  const actor = actorForScope(input.scope);

  if (input.expectedVersion !== undefined && input.expectedVersion !== order.row_version) {
    throw new ConflictError("this order was updated by someone else; refresh and try again");
  }

  try {
    assertTransition({
      from: order.status,
      to: input.to,
      actor,
      ...(input.permissions ? { permissions: input.permissions } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
  } catch (e) {
    if (e instanceof TransitionError) throw new RuleViolationError(e.message, e.code);
    throw e;
  }

  const { rows } = await db.query<OrderRow>(`UPDATE orders SET status = $2 WHERE id = $1 RETURNING ${ORDER_COLUMNS}`, [order.id, input.to]);
  const updated = rows[0]!;

  await db.query(
    `INSERT INTO order_events (order_id, university_id, from_status, to_status, actor_kind, actor_user_id, device_id, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [order.id, order.university_id, order.status, input.to, actor, input.actorUserId, input.deviceId ?? null, input.reason ?? null],
  );
  await db.query(
    `INSERT INTO audit_log (university_id, shop_id, actor_user_id, actor_kind, action, entity_type, entity_id, request_id, details)
     VALUES ($1, $2, $3, $4, 'order.status_changed', 'order', $5, $6, $7)`,
    [order.university_id, order.shop_id, input.actorUserId, actor, order.id, input.requestId ?? null, JSON.stringify({ from: order.status, to: input.to })],
  );

  // Queue maintenance happens in the same transaction as the status change.
  if (input.to === "PAID") {
    await db.query(`INSERT INTO queue_entries (order_id, shop_id) VALUES ($1, $2) ON CONFLICT (order_id) DO NOTHING`, [order.id, order.shop_id]);
  } else if (!(QUEUED_STATUSES as readonly string[]).includes(input.to)) {
    await db.query(`DELETE FROM queue_entries WHERE order_id = $1`, [order.id]);
  }

  const notice = STUDENT_NOTICES[input.to];
  if (notice) {
    await db.query(
      `INSERT INTO notifications (user_id, kind, title, body, order_id) VALUES ($1, $2, $3, $4, $5)`,
      [order.student_user_id, `order.${input.to.toLowerCase()}`, notice.title, `${order.reference}: ${notice.body}`, order.id],
    );
    await db.query(`INSERT INTO jobs (kind, payload) VALUES ('NOTIFY', $1)`, [
      JSON.stringify({ userId: order.student_user_id, orderId: order.id, status: input.to }),
    ]);
  }

  // A rejected job is always refunded in full, automatically.
  if (input.to === "REJECTED") {
    return transitionOrder(db, { orderId: order.id, to: "REFUND_PENDING", scope: { kind: "SYSTEM" }, actorUserId: null, reason: "Rejected by shop" });
  }
  if (input.to === "REFUND_PENDING") {
    await openFullRefund(db, order.id, input.reason ?? "Order refunded", input.actorUserId);
  }

  return updated;
}

/** Creates the refund record for the full remaining paid amount, if any. */
async function openFullRefund(db: Queryable, orderId: string, reason: string, requestedBy: string | null): Promise<void> {
  const { rows } = await db.query<{ id: string; university_id: string; remaining: string }>(
    `SELECT p.id, p.university_id,
            p.amount_kobo - COALESCE((SELECT sum(r.amount_kobo) FROM refunds r WHERE r.payment_id = p.id AND r.status <> 'FAILED'), 0) AS remaining
       FROM payments p WHERE p.order_id = $1 AND p.status = 'SUCCEEDED'`,
    [orderId],
  );
  const pay = rows[0];
  if (!pay || Number(pay.remaining) <= 0) return;
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO refunds (payment_id, order_id, university_id, amount_kobo, reason, idempotency_key, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [pay.id, orderId, pay.university_id, Number(pay.remaining), reason.slice(0, 1000).padEnd(3, "."), `order-refund:${orderId}`, requestedBy],
  );
  if (inserted.rows[0]) {
    await db.query(`INSERT INTO jobs (kind, payload, dedupe_key) VALUES ('REFUND_PROCESS', $1, $2) ON CONFLICT (dedupe_key) DO NOTHING`, [
      JSON.stringify({ refundId: inserted.rows[0].id }),
      `refund:${inserted.rows[0].id}`,
    ]);
  }
}

/** Position (1-based) of an order in its shop's queue, or null if not queued. */
export async function queuePosition(db: Queryable, orderId: string): Promise<number | null> {
  const { rows } = await db.query<{ position: string }>(
    `SELECT position FROM (
       SELECT order_id, row_number() OVER (PARTITION BY shop_id ORDER BY priority DESC, enqueued_at, order_id) AS position
         FROM queue_entries WHERE shop_id = (SELECT shop_id FROM queue_entries WHERE order_id = $1)
     ) q WHERE order_id = $1`,
    [orderId],
  );
  return rows[0] ? Number(rows[0].position) : null;
}
