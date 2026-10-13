import { randomUUID } from "node:crypto";
import {
  evaluatePickupAttempt,
  generatePickupCode,
  hashPickupCode,
  PICKUP_CODE_TTL_MS,
  type ShopPermission,
} from "../../domain/src/index.js";
import { RuleViolationError } from "./errors.js";
import { lockOrder, transitionOrder, type OrderScope } from "./orders.js";
import type { Queryable } from "./tx.js";

/**
 * Issues a fresh pickup code, revoking any previous live one. Returns the
 * plaintext code exactly once, for delivery to the student; only its HMAC is stored.
 */
export async function issuePickupToken(
  db: Queryable,
  params: { orderId: string; pepper: string; now?: Date; scope?: OrderScope },
): Promise<{ tokenId: string; code: string; expiresAt: Date }> {
  const now = params.now ?? new Date();
  const order = await lockOrder(db, params.orderId, params.scope ?? { kind: "SYSTEM" });
  if (order.status !== "READY_FOR_PICKUP") {
    throw new RuleViolationError("pickup codes are only issued for orders ready for pickup", "NOT_READY");
  }
  await db.query(`UPDATE pickup_tokens SET revoked_at = $2 WHERE order_id = $1 AND used_at IS NULL AND revoked_at IS NULL`, [params.orderId, now]);
  const tokenId = randomUUID();
  const code = generatePickupCode();
  const expiresAt = new Date(now.getTime() + PICKUP_CODE_TTL_MS);
  await db.query(`INSERT INTO pickup_tokens (id, order_id, code_hash, expires_at, created_at) VALUES ($1, $2, $3, $4, $5)`, [
    tokenId,
    params.orderId,
    hashPickupCode(params.pepper, params.orderId, tokenId, code),
    expiresAt,
    now,
  ]);
  return { tokenId, code, expiresAt };
}

export type RedeemResult =
  | { ok: true }
  | {
      ok: false;
      reason: "ALREADY_COLLECTED" | "NOT_READY" | "NO_ACTIVE_CODE" | "EXPIRED" | "USED" | "REVOKED" | "LOCKED" | "WRONG_CODE";
      attemptsRemaining: number;
    };

/**
 * Verifies a pickup code at the counter and marks the order collected.
 * Must run in its own transaction and that transaction must be COMMITTED even
 * when the result is a failure, so failed attempts are counted.
 *
 * Concurrency: the order row and the token row are both locked, so two staff
 * devices redeeming the same code at once serialise; the second sees COLLECTED.
 */
export async function redeemPickupCode(
  db: Queryable,
  params: {
    orderId: string;
    shopId: string;
    staffUserId: string;
    permissions: readonly ShopPermission[];
    candidate: string;
    pepper: string;
    now?: Date;
  },
): Promise<RedeemResult> {
  const now = params.now ?? new Date();
  if (!params.permissions.includes("orders.collect")) {
    throw new RuleViolationError("requires shop permission orders.collect", "MISSING_PERMISSION");
  }
  const order = await lockOrder(db, params.orderId, { kind: "SHOP", shopId: params.shopId });
  if (order.status === "COLLECTED") return { ok: false, reason: "ALREADY_COLLECTED", attemptsRemaining: 0 };
  if (order.status !== "READY_FOR_PICKUP") return { ok: false, reason: "NOT_READY", attemptsRemaining: 0 };

  const { rows } = await db.query<{
    id: string;
    code_hash: string;
    expires_at: Date;
    used_at: Date | null;
    revoked_at: Date | null;
    failed_attempts: number;
  }>(
    `SELECT id, code_hash, expires_at, used_at, revoked_at, failed_attempts
       FROM pickup_tokens WHERE order_id = $1 AND used_at IS NULL AND revoked_at IS NULL FOR UPDATE`,
    [order.id],
  );
  const token = rows[0];
  if (!token) return { ok: false, reason: "NO_ACTIVE_CODE", attemptsRemaining: 0 };

  const verdict = evaluatePickupAttempt(
    { codeHash: token.code_hash, expiresAt: token.expires_at, usedAt: token.used_at, revokedAt: token.revoked_at, failedAttempts: token.failed_attempts },
    { pepper: params.pepper, orderId: order.id, tokenId: token.id, candidate: params.candidate, now },
  );

  if (!verdict.ok) {
    if (verdict.reason === "WRONG_CODE") {
      await db.query(`UPDATE pickup_tokens SET failed_attempts = failed_attempts + 1 WHERE id = $1`, [token.id]);
    }
    await db.query(
      `INSERT INTO audit_log (university_id, shop_id, actor_user_id, actor_kind, action, entity_type, entity_id, details)
       VALUES ($1, $2, $3, 'SHOP_STAFF', 'pickup.failed_attempt', 'order', $4, $5)`,
      [order.university_id, order.shop_id, params.staffUserId, order.id, JSON.stringify({ reason: verdict.reason })],
    );
    return verdict;
  }

  await db.query(`UPDATE pickup_tokens SET used_at = $2, used_by = $3 WHERE id = $1`, [token.id, now, params.staffUserId]);
  await transitionOrder(db, {
    orderId: order.id,
    to: "COLLECTED",
    scope: { kind: "SHOP", shopId: params.shopId },
    actorUserId: params.staffUserId,
    permissions: params.permissions,
  });
  return { ok: true };
}
