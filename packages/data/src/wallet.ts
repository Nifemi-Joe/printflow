import { NotFoundError, RuleViolationError } from "./errors.js";
import { enqueueRefund, requestRefund } from "./payments.js";
import type { Queryable } from "./tx.js";

/**
 * Student wallet: a closed-loop, spend-only balance (see migration 0007).
 *
 * CASH is money the student paid in and refunds of what they paid. PROMO is credit
 * the university granted. Promo is spent first and never turns into cash. Every
 * change is a wallet_entries row; the database keeps the balance and refuses
 * anything that would take it below zero, spend on an order that is not awaiting
 * payment, or give back more than an order took.
 */

export type RefundDestination = "WALLET" | "PROVIDER";

export interface WalletBalance {
  cashKobo: number;
  promoKobo: number;
  totalKobo: number;
}

export interface WalletNotice {
  userId: string;
  kind: string;
  title: string;
  body: string;
  /** Also send an SMS (to a verified phone). */
  sms: boolean;
}

/** Records an in-app notification and queues email (and optionally SMS) delivery. */
export async function notifyWallet(db: Queryable, n: WalletNotice): Promise<void> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO notifications (user_id, kind, title, body) VALUES ($1, $2, $3, $4) RETURNING id`,
    [n.userId, n.kind, n.title, n.body],
  );
  await db.query(`INSERT INTO jobs (kind, payload) VALUES ('NOTIFY', $1)`, [
    JSON.stringify({ userId: n.userId, notificationId: Number(rows[0]!.id), sms: n.sms, link: "/student/wallet" }),
  ]);
}

export function naira(kobo: number): string {
  const n = kobo / 100;
  return `₦${n.toLocaleString("en-NG", { minimumFractionDigits: n % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
}

export async function walletBalance(db: Queryable, userId: string): Promise<WalletBalance> {
  const { rows } = await db.query<{ cash_kobo: string; promo_kobo: string }>(`SELECT cash_kobo, promo_kobo FROM wallets WHERE user_id = $1`, [userId]);
  if (!rows[0]) throw new NotFoundError("wallet not found");
  const cash = Number(rows[0].cash_kobo);
  const promo = Number(rows[0].promo_kobo);
  return { cashKobo: cash, promoKobo: promo, totalKobo: cash + promo };
}

/** What the wallet currently covers on an order (taken minus given back), per bucket. */
export async function walletOnOrder(db: Queryable, orderId: string): Promise<{ cashKobo: number; promoKobo: number; totalKobo: number }> {
  const { rows } = await db.query<{ cash: string; promo: string }>(
    `SELECT -COALESCE(sum(cash_kobo), 0) AS cash, -COALESCE(sum(promo_kobo), 0) AS promo
       FROM wallet_entries WHERE order_id = $1 AND kind IN ('ORDER_PAYMENT', 'ORDER_RETURN')`,
    [orderId],
  );
  const cash = Number(rows[0]!.cash);
  const promo = Number(rows[0]!.promo);
  return { cashKobo: cash, promoKobo: promo, totalKobo: cash + promo };
}

/**
 * Puts the student's balance towards an unpaid order: promo first, then cash, up to
 * the order total. Applied once per order; calling again returns what was applied.
 * Run in a transaction. The caller decides what happens to the remainder (pay it by
 * card/transfer/USSD, or mark the order paid when nothing is left).
 */
export async function applyWalletToOrder(
  db: Queryable,
  params: { orderId: string; userId: string; lowBalanceKobo: number },
): Promise<{ appliedKobo: number; remainingKobo: number; alreadyApplied: boolean }> {
  const { rows } = await db.query<{ status: string; total_kobo: string; university_id: string; reference: string }>(
    `SELECT status, total_kobo, university_id, reference FROM orders WHERE id = $1 AND student_user_id = $2 FOR UPDATE`,
    [params.orderId, params.userId],
  );
  const order = rows[0];
  if (!order) throw new NotFoundError("order not found");
  const total = Number(order.total_kobo);
  const existing = await walletOnOrder(db, params.orderId);
  const paid = await db.query(`SELECT 1 FROM wallet_entries WHERE order_id = $1 AND kind = 'ORDER_PAYMENT'`, [params.orderId]);
  if (paid.rowCount) return { appliedKobo: existing.totalKobo, remainingKobo: total - existing.totalKobo, alreadyApplied: true };
  if (order.status !== "AWAITING_PAYMENT") throw new RuleViolationError("this order is not awaiting payment", "NOT_PAYABLE");

  const w = await db.query<{ cash_kobo: string; promo_kobo: string }>(`SELECT cash_kobo, promo_kobo FROM wallets WHERE user_id = $1 FOR UPDATE`, [params.userId]);
  if (!w.rows[0]) throw new NotFoundError("wallet not found");
  const cash = Number(w.rows[0].cash_kobo);
  const promo = Number(w.rows[0].promo_kobo);
  const take = Math.min(total, cash + promo);
  if (take <= 0) return { appliedKobo: 0, remainingKobo: total, alreadyApplied: false };
  const fromPromo = Math.min(promo, take);
  const fromCash = take - fromPromo;
  await db.query(
    `INSERT INTO wallet_entries (user_id, university_id, kind, cash_kobo, promo_kobo, order_id, idempotency_key, note)
     VALUES ($1, $2, 'ORDER_PAYMENT', $3, $4, $5, $6, $7)`,
    [params.userId, order.university_id, -fromCash, -fromPromo, params.orderId, `order-wallet:${params.orderId}`, `Paid towards ${order.reference}`],
  );
  const before = cash + promo;
  const after = before - take;
  if (before >= params.lowBalanceKobo && after < params.lowBalanceKobo && params.lowBalanceKobo > 0) {
    await notifyWallet(db, {
      userId: params.userId,
      kind: "wallet.low_balance",
      title: "Wallet balance is low",
      body: `Your PrintFlow wallet has ${naira(after)} left. Top up so your next print is one tap.`,
      sms: true,
    });
  }
  return { appliedKobo: take, remainingKobo: total - take, alreadyApplied: false };
}

/** Gives back whatever an unpaid order took from the wallet (cancelled or expired). */
export async function releaseWalletFromOrder(db: Queryable, orderId: string, why: string): Promise<number> {
  const on = await walletOnOrder(db, orderId);
  if (on.totalKobo <= 0) return 0;
  const o = await db.query<{ student_user_id: string; university_id: string; reference: string }>(
    `SELECT student_user_id, university_id, reference FROM orders WHERE id = $1`,
    [orderId],
  );
  const order = o.rows[0]!;
  const ins = await db.query(
    `INSERT INTO wallet_entries (user_id, university_id, kind, cash_kobo, promo_kobo, order_id, idempotency_key, note)
     VALUES ($1, $2, 'ORDER_RETURN', $3, $4, $5, $6, $7) ON CONFLICT (idempotency_key) DO NOTHING`,
    [order.student_user_id, order.university_id, on.cashKobo, on.promoKobo, orderId, `order-release:${orderId}`, `${order.reference} ${why}`.slice(0, 500)],
  );
  return ins.rowCount ? on.totalKobo : 0;
}

export interface RefundResult {
  /** Returned to the wallet: the wallet part of the order plus any card money refunded to the wallet. */
  toWalletKobo: number;
  /** Sent back to the card or bank through the provider (settles later). */
  toProviderKobo: number;
  providerRefundId: string | null;
  replayed: boolean;
}

/**
 * Refunds a paid order, in whole (amountKobo omitted) or in part.
 *
 * What came from the wallet always goes back to the wallet, in the same buckets
 * (cash stays cash, promo stays promo). Money paid by card, transfer or USSD goes to
 * `destination`: the wallet (instant) or back through the provider (days).
 * For a partial refund the student's own money is returned first: wallet cash, then
 * the card part, then promo credit.
 *
 * Run in a transaction with the order locked. The refunds table's cap trigger and the
 * ledger's per-order check make it impossible to return more than was paid.
 */
export async function refundOrder(
  db: Queryable,
  params: { orderId: string; amountKobo?: number; destination: RefundDestination; reason: string; idempotencyKey: string; requestedBy: string | null },
): Promise<RefundResult> {
  const prior = await db.query(
    `SELECT 1 FROM wallet_entries WHERE idempotency_key = $1 UNION ALL SELECT 1 FROM refunds WHERE idempotency_key = $2`,
    [`${params.idempotencyKey}:wallet`, params.idempotencyKey],
  );
  if (prior.rowCount) return { toWalletKobo: 0, toProviderKobo: 0, providerRefundId: null, replayed: true };

  const o = await db.query<{ student_user_id: string; university_id: string; reference: string }>(
    `SELECT student_user_id, university_id, reference FROM orders WHERE id = $1`,
    [params.orderId],
  );
  const order = o.rows[0];
  if (!order) throw new NotFoundError("order not found");

  const wallet = await walletOnOrder(db, params.orderId);
  const pay = await db.query<{ id: string; remaining: string }>(
    `SELECT p.id, p.amount_kobo - COALESCE((SELECT sum(r.amount_kobo) FROM refunds r WHERE r.payment_id = p.id AND r.status <> 'FAILED'), 0) AS remaining
       FROM payments p WHERE p.order_id = $1 AND p.status = 'SUCCEEDED' FOR UPDATE OF p`,
    [params.orderId],
  );
  const card = pay.rows[0] ? Math.max(0, Number(pay.rows[0].remaining)) : 0;
  const refundable = wallet.totalKobo + card;
  const amount = params.amountKobo ?? refundable;
  if (!Number.isSafeInteger(amount) || amount < 0) throw new RuleViolationError("refund amount must be a whole number of kobo", "INVALID_AMOUNT");
  if (amount > refundable) throw new RuleViolationError(`at most ${naira(refundable)} can be refunded on this order`, "REFUND_TOO_LARGE");
  if (amount === 0) return { toWalletKobo: 0, toProviderKobo: 0, providerRefundId: null, replayed: false };

  let left = amount;
  const walletCash = Math.min(wallet.cashKobo, left);
  left -= walletCash;
  const cardPart = Math.min(card, left);
  left -= cardPart;
  const walletPromo = Math.min(wallet.promoKobo, left);
  left -= walletPromo;

  let toWallet = 0;
  let toProvider = 0;
  let providerRefundId: string | null = null;
  const note = `${order.reference}: ${params.reason}`.slice(0, 500);

  if (walletCash + walletPromo > 0) {
    await db.query(
      `INSERT INTO wallet_entries (user_id, university_id, kind, cash_kobo, promo_kobo, order_id, idempotency_key, note, created_by)
       VALUES ($1, $2, 'ORDER_RETURN', $3, $4, $5, $6, $7, $8)`,
      [order.student_user_id, order.university_id, walletCash, walletPromo, params.orderId, `${params.idempotencyKey}:wallet`, note, params.requestedBy],
    );
    toWallet += walletCash + walletPromo;
  }

  if (cardPart > 0) {
    const paymentId = pay.rows[0]!.id;
    if (params.destination === "WALLET") {
      const r = await db.query<{ id: string }>(
        `INSERT INTO refunds (payment_id, order_id, university_id, amount_kobo, reason, idempotency_key, requested_by, destination, status, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'WALLET', 'SUCCEEDED', now()) RETURNING id`,
        [paymentId, params.orderId, order.university_id, cardPart, params.reason.slice(0, 1000).padEnd(3, "."), params.idempotencyKey, params.requestedBy],
      );
      await db.query(
        `INSERT INTO wallet_entries (user_id, university_id, kind, cash_kobo, order_id, refund_id, idempotency_key, note, created_by)
         VALUES ($1, $2, 'CARD_REFUND', $3, $4, $5, $6, $7, $8)`,
        [order.student_user_id, order.university_id, cardPart, params.orderId, r.rows[0]!.id, `${params.idempotencyKey}:card`, note, params.requestedBy],
      );
      toWallet += cardPart;
    } else {
      const r = await requestRefund(db, {
        orderId: params.orderId,
        paymentId,
        amountKobo: cardPart,
        reason: params.reason.slice(0, 1000).padEnd(3, "."),
        idempotencyKey: params.idempotencyKey,
        requestedBy: params.requestedBy,
      });
      await enqueueRefund(db, r.refundId);
      providerRefundId = r.refundId;
      toProvider = cardPart;
    }
  }

  if (toWallet > 0) {
    await notifyWallet(db, {
      userId: order.student_user_id,
      kind: "wallet.refund",
      title: "Refund added to your wallet",
      body: `${naira(toWallet)} from ${order.reference} is back in your PrintFlow wallet and ready to use.`,
      sms: false,
    });
  }
  return { toWalletKobo: toWallet, toProviderKobo: toProvider, providerRefundId, replayed: false };
}

/** True when an order has no provider refund still waiting to settle. */
export async function noRefundInFlight(db: Queryable, orderId: string): Promise<boolean> {
  const open = await db.query(`SELECT 1 FROM refunds WHERE order_id = $1 AND status IN ('REQUESTED', 'PROCESSING')`, [orderId]);
  return open.rowCount === 0;
}

// ---------------------------------------------------------------- top-ups

/**
 * Credits a top-up the provider confirmed. Run in a transaction (from the webhook
 * path). Returns false if it was already credited.
 */
export async function creditTopup(db: Queryable, topupId: string, confirmedKobo: number, channel: string | null): Promise<boolean> {
  const { rows } = await db.query<{ user_id: string; university_id: string; status: string; amount_kobo: string }>(
    `SELECT user_id, university_id, status, amount_kobo FROM wallet_topups WHERE id = $1 FOR UPDATE`,
    [topupId],
  );
  const t = rows[0];
  if (!t || t.status === "SUCCEEDED") return false;
  await db.query(`UPDATE wallet_topups SET status = 'SUCCEEDED', confirmed_amount_kobo = $2, confirmed_at = now(), channel = COALESCE($3, channel) WHERE id = $1`, [
    topupId,
    confirmedKobo,
    channel,
  ]);
  await db.query(
    `INSERT INTO wallet_entries (user_id, university_id, kind, cash_kobo, topup_id, idempotency_key, note)
     VALUES ($1, $2, 'TOPUP', $3, $4, $5, 'Top-up')`,
    [t.user_id, t.university_id, confirmedKobo, topupId, `topup:${topupId}`],
  );
  const bal = await walletBalance(db, t.user_id);
  await notifyWallet(db, {
    userId: t.user_id,
    kind: "wallet.topup",
    title: "Wallet topped up",
    body: `${naira(confirmedKobo)} added to your PrintFlow wallet. Balance: ${naira(bal.totalKobo)}.`,
    sms: true,
  });
  return true;
}

// ---------------------------------------------------------------- promo credit

export async function grantPromo(
  db: Queryable,
  params: { userId: string; universityId: string; amountKobo: number; note: string; grantedBy: string; idempotencyKey: string },
): Promise<void> {
  await db.query(
    `INSERT INTO wallet_entries (user_id, university_id, kind, promo_kobo, idempotency_key, note, created_by)
     VALUES ($1, $2, 'PROMO_GRANT', $3, $4, $5, $6)`,
    [params.userId, params.universityId, params.amountKobo, params.idempotencyKey, params.note, params.grantedBy],
  );
  await notifyWallet(db, {
    userId: params.userId,
    kind: "wallet.promo",
    title: "You've got print credit",
    body: `${naira(params.amountKobo)} of print credit was added to your PrintFlow wallet: ${params.note}`.slice(0, 1000),
    sms: false,
  });
}

/** Takes back unspent promo credit. Cash is never touched. */
export async function revokePromo(
  db: Queryable,
  params: { userId: string; universityId: string; amountKobo: number; note: string; revokedBy: string; idempotencyKey: string },
): Promise<void> {
  const bal = await db.query<{ promo_kobo: string }>(`SELECT promo_kobo FROM wallets WHERE user_id = $1 AND university_id = $2 FOR UPDATE`, [params.userId, params.universityId]);
  if (!bal.rows[0]) throw new NotFoundError("student not found");
  if (Number(bal.rows[0].promo_kobo) < params.amountKobo) {
    throw new RuleViolationError(`only ${naira(Number(bal.rows[0].promo_kobo))} of unspent credit can be taken back`, "PROMO_ALREADY_SPENT");
  }
  await db.query(
    `INSERT INTO wallet_entries (user_id, university_id, kind, promo_kobo, idempotency_key, note, created_by)
     VALUES ($1, $2, 'PROMO_REVOKE', $3, $4, $5, $6)`,
    [params.userId, params.universityId, -params.amountKobo, params.idempotencyKey, params.note, params.revokedBy],
  );
}

/**
 * Grants the university's welcome credit once per student, on first confirming a
 * phone number (phones cost money to farm; email addresses do not).
 */
export async function grantWelcomeCredit(db: Queryable, userId: string): Promise<number> {
  const { rows } = await db.query<{ university_id: string; welcome_credit_kobo: string }>(
    `SELECT w.university_id, u.welcome_credit_kobo FROM wallets w JOIN universities u ON u.id = w.university_id WHERE w.user_id = $1`,
    [userId],
  );
  const r = rows[0];
  const amount = r ? Number(r.welcome_credit_kobo) : 0;
  if (!r || amount <= 0) return 0;
  const ins = await db.query(
    `INSERT INTO wallet_entries (user_id, university_id, kind, promo_kobo, idempotency_key, note)
     VALUES ($1, $2, 'WELCOME_CREDIT', $3, $4, 'Welcome credit') ON CONFLICT DO NOTHING`,
    [userId, r.university_id, amount, `welcome:${userId}`],
  );
  if (!ins.rowCount) return 0;
  await notifyWallet(db, {
    userId,
    kind: "wallet.welcome",
    title: "Welcome credit added",
    body: `${naira(amount)} of print credit is in your PrintFlow wallet. It's used automatically at checkout.`,
    sms: false,
  });
  return amount;
}

// ---------------------------------------------------------------- statement

export const WALLET_ENTRY_LABELS: Record<string, string> = {
  TOPUP: "Top-up",
  ORDER_PAYMENT: "Paid for printing",
  ORDER_RETURN: "Returned from an order",
  CARD_REFUND: "Refund",
  UNMATCHED_PAYMENT: "Payment received for an old checkout",
  PROMO_GRANT: "Print credit",
  WELCOME_CREDIT: "Welcome credit",
  PROMO_REVOKE: "Print credit removed",
};

export async function walletStatement(db: Queryable, userId: string, opts: { limit: number; beforeId?: number }) {
  const { rows } = await db.query<{ id: string; kind: string; cash_kobo: string; promo_kobo: string; order_id: string | null; order_reference: string | null; note: string | null; created_at: Date }>(
    `SELECT e.id, e.kind, e.cash_kobo, e.promo_kobo, e.order_id, o.reference AS order_reference, e.note, e.created_at
       FROM wallet_entries e LEFT JOIN orders o ON o.id = e.order_id
      WHERE e.user_id = $1 AND ($2::bigint IS NULL OR e.id < $2) ORDER BY e.id DESC LIMIT $3`,
    [userId, opts.beforeId ?? null, opts.limit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    kind: r.kind,
    label: WALLET_ENTRY_LABELS[r.kind] ?? r.kind,
    cashKobo: Number(r.cash_kobo),
    promoKobo: Number(r.promo_kobo),
    amountKobo: Number(r.cash_kobo) + Number(r.promo_kobo),
    orderId: r.order_id,
    orderReference: r.order_reference,
    note: r.note,
    createdAt: r.created_at,
  }));
}
