import {
  atLeast,
  CHECK_GRANTS,
  providerLimits,
  surnameMatches,
  trustBadge,
  TRUSTED_FROM,
  type ProviderKind,
  type ProviderLimits,
  type TrustBadge,
  type VerificationCheck,
  type VerificationLevel,
} from "../../domain/src/index.js";
import { NotFoundError, RuleViolationError } from "./errors.js";
import type { Queryable } from "./tx.js";

/**
 * Provider identity verification (see migration 0008).
 *
 * A shop's level is never written directly: it is derived by a database trigger from the
 * checks that have passed. Everything here either records a check or reads the result,
 * so the level and the evidence behind it can never disagree.
 */

export interface ProviderTrust {
  shopId: string;
  universityId: string;
  name: string;
  kind: ProviderKind;
  level: VerificationLevel;
  badge: TrustBadge;
  limits: ProviderLimits;
  /** True once the owner has accepted the current confidentiality undertaking. */
  undertakingAccepted: boolean;
}

export async function providerTrust(db: Queryable, shopId: string): Promise<ProviderTrust> {
  const { rows } = await db.query<{
    university_id: string;
    name: string;
    kind: ProviderKind;
    verification_level: VerificationLevel;
    undertaking_version: number | null;
    cap: string;
  }>(
    `SELECT s.university_id, s.name, s.kind, s.verification_level, s.undertaking_version, u.student_provider_cap_kobo AS cap
       FROM shops s JOIN universities u ON u.id = s.university_id WHERE s.id = $1`,
    [shopId],
  );
  const s = rows[0];
  if (!s) throw new NotFoundError("shop not found");
  return {
    shopId,
    universityId: s.university_id,
    name: s.name,
    kind: s.kind,
    level: s.verification_level,
    badge: trustBadge(s.kind, s.verification_level),
    limits: providerLimits(s.kind, s.verification_level, Number(s.cap)),
    undertakingAccepted: s.undertaking_version !== null,
  };
}

/** Whether an order at this shop needs the student to acknowledge the risk first. */
export function needsAcknowledgement(t: Pick<ProviderTrust, "kind" | "level">): boolean {
  return t.kind === "STUDENT_RUN" && !atLeast(t.level, TRUSTED_FROM);
}

export interface CheckRow {
  id: string;
  kind: VerificationCheck;
  status: string;
  subject: string;
  evidence: Record<string, unknown>;
  note: string | null;
  requestedAt: Date;
  decidedAt: Date | null;
  expiresAt: Date | null;
  decidedByName: string | null;
}

export async function providerChecks(db: Queryable, shopId: string): Promise<CheckRow[]> {
  const { rows } = await db.query<{
    id: string;
    kind: VerificationCheck;
    status: string;
    subject: string;
    evidence: Record<string, unknown>;
    note: string | null;
    requested_at: Date;
    decided_at: Date | null;
    expires_at: Date | null;
    decided_by_name: string | null;
  }>(
    `SELECT v.id, v.kind, v.status, v.subject, v.evidence, v.note, v.requested_at, v.decided_at, v.expires_at, u.full_name AS decided_by_name
       FROM provider_verifications v LEFT JOIN users u ON u.id = v.decided_by
      WHERE v.shop_id = $1 ORDER BY v.requested_at DESC`,
    [shopId],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    subject: r.subject,
    evidence: r.evidence,
    note: r.note,
    requestedAt: r.requested_at,
    decidedAt: r.decided_at,
    expiresAt: r.expires_at,
    decidedByName: r.decided_by_name,
  }));
}

/** The live (pending or passed) check of this kind, if there is one. */
async function liveCheck(db: Queryable, shopId: string, kind: VerificationCheck) {
  const { rows } = await db.query<{ id: string; status: string; subject: string }>(
    `SELECT id, status, subject FROM provider_verifications WHERE shop_id = $1 AND kind = $2 AND status IN ('PENDING', 'PASSED') FOR UPDATE`,
    [shopId, kind],
  );
  return rows[0] ?? null;
}

/** Opens a check for a decision that has to be made by a person. */
export async function requestCheck(
  db: Queryable,
  params: { shopId: string; universityId: string; kind: VerificationCheck; subject: string; evidence?: Record<string, unknown> },
): Promise<{ id: string }> {
  const live = await liveCheck(db, params.shopId, params.kind);
  if (live?.status === "PASSED") throw new RuleViolationError("this check has already passed", "CHECK_ALREADY_PASSED");
  if (live) {
    await db.query(`UPDATE provider_verifications SET status = 'FAILED', decided_at = now(), note = 'Replaced by a new request' WHERE id = $1`, [live.id]);
  }
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO provider_verifications (shop_id, university_id, kind, status, subject, evidence) VALUES ($1, $2, $3, 'PENDING', $4, $5) RETURNING id`,
    [params.shopId, params.universityId, params.kind, params.subject, JSON.stringify(params.evidence ?? {})],
  );
  return { id: rows[0]!.id };
}

/**
 * Records a check as passed, which raises the shop's level through the database trigger.
 * Re-running it for the same subject renews the expiry; a different subject supersedes
 * the old check rather than editing it, so the trail keeps both.
 */
export async function passCheck(
  db: Queryable,
  params: {
    shopId: string;
    universityId: string;
    kind: VerificationCheck;
    subject: string;
    evidence: Record<string, unknown>;
    decidedBy: string | null;
    validForDays: number;
    note?: string;
  },
): Promise<{ id: string; grants: VerificationLevel }> {
  const expiresAt = new Date(Date.now() + params.validForDays * 86_400_000);
  const live = await liveCheck(db, params.shopId, params.kind);
  if (live && live.subject === params.subject) {
    const { rows } = await db.query<{ id: string }>(
      `UPDATE provider_verifications SET status = 'PASSED', evidence = $2, decided_by = $3, decided_at = now(), expires_at = $4, note = $5
        WHERE id = $1 RETURNING id`,
      [live.id, JSON.stringify(params.evidence), params.decidedBy, expiresAt, params.note ?? null],
    );
    return { id: rows[0]!.id, grants: CHECK_GRANTS[params.kind] };
  }
  if (live) {
    await db.query(
      `UPDATE provider_verifications SET status = ${live.status === "PASSED" ? "'REVOKED'" : "'FAILED'"}, decided_at = now(), note = 'Superseded by a later check' WHERE id = $1`,
      [live.id],
    );
  }
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO provider_verifications (shop_id, university_id, kind, status, subject, evidence, decided_by, decided_at, expires_at, note)
     VALUES ($1, $2, $3, 'PASSED', $4, $5, $6, now(), $7, $8) RETURNING id`,
    [params.shopId, params.universityId, params.kind, params.subject, JSON.stringify(params.evidence), params.decidedBy, expiresAt, params.note ?? null],
  );
  return { id: rows[0]!.id, grants: CHECK_GRANTS[params.kind] };
}

export async function failCheck(db: Queryable, params: { checkId: string; decidedBy: string | null; note: string }): Promise<void> {
  const { rowCount } = await db.query(
    `UPDATE provider_verifications SET status = 'FAILED', decided_by = $2, decided_at = now(), note = $3 WHERE id = $1 AND status = 'PENDING'`,
    [params.checkId, params.decidedBy, params.note],
  );
  if (!rowCount) throw new RuleViolationError("this check is not waiting for a decision", "CHECK_NOT_PENDING");
}

/** Withdraws a passed check, which drops the shop's level immediately. */
export async function revokeCheck(db: Queryable, params: { checkId: string; decidedBy: string; note: string }): Promise<{ shopId: string }> {
  const { rows } = await db.query<{ shop_id: string }>(
    `UPDATE provider_verifications SET status = 'REVOKED', decided_by = $2, decided_at = now(), note = $3 WHERE id = $1 AND status = 'PASSED' RETURNING shop_id`,
    [params.checkId, params.decidedBy, params.note],
  );
  if (!rows[0]) throw new RuleViolationError("this check is not currently standing", "CHECK_NOT_PASSED");
  return { shopId: rows[0].shop_id };
}

/**
 * Lapses every check whose renewal date has passed. Shops drop a level as it runs, so a
 * provider who has left the university stops being described as a current student.
 */
export async function expireDueChecks(db: Queryable, limit = 500): Promise<Array<{ shopId: string; kind: VerificationCheck }>> {
  const { rows } = await db.query<{ shop_id: string; kind: VerificationCheck }>(
    `UPDATE provider_verifications SET status = 'EXPIRED', note = COALESCE(note, 'Renewal date passed')
      WHERE id IN (SELECT id FROM provider_verifications WHERE status = 'PASSED' AND expires_at IS NOT NULL AND expires_at <= now() ORDER BY expires_at LIMIT $1)
      RETURNING shop_id, kind`,
    [limit],
  );
  return rows.map((r) => ({ shopId: r.shop_id, kind: r.kind }));
}

// ---------------------------------------------------------------- the student roll

/**
 * Looks a matric number up in the university's roll, if it uploaded one.
 * Returns null when there is no roll to check against, so the caller can tell
 * "no match" apart from "nothing to match against".
 */
export async function matchRoll(
  db: Queryable,
  params: { universityId: string; matric: string; surnames: readonly string[]; pepper: string },
): Promise<boolean | null> {
  const any = await db.query(`SELECT 1 FROM university_student_roll WHERE university_id = $1 LIMIT 1`, [params.universityId]);
  if (!any.rowCount) return null;
  const { rows } = await db.query<{ surname_hash: string }>(
    `SELECT surname_hash FROM university_student_roll WHERE university_id = $1 AND matric_number = $2`,
    [params.universityId, params.matric],
  );
  if (!rows[0]) return false;
  return params.surnames.some((s) => surnameMatches(params.pepper, s, rows[0]!.surname_hash));
}

/** Replaces a university's roll wholesale, so an old upload cannot linger. */
export async function replaceRoll(
  db: Queryable,
  params: { universityId: string; batchId: string; rows: ReadonlyArray<{ matric: string; surnameHash: string }> },
): Promise<number> {
  await db.query(`DELETE FROM university_student_roll WHERE university_id = $1`, [params.universityId]);
  if (params.rows.length === 0) return 0;
  const values: unknown[] = [params.universityId, params.batchId];
  const tuples = params.rows.map((r) => {
    values.push(r.matric, r.surnameHash);
    return `($1, $${values.length - 1}, $${values.length}, $2)`;
  });
  const { rowCount } = await db.query(
    `INSERT INTO university_student_roll (university_id, matric_number, surname_hash, batch_id) VALUES ${tuples.join(", ")} ON CONFLICT DO NOTHING`,
    values,
  );
  return rowCount ?? 0;
}

// ---------------------------------------------------------------- undertaking

export async function acceptUndertaking(
  db: Queryable,
  params: { shopId: string; universityId: string; userId: string; version: number; textSha256: string; ip: string | null },
): Promise<void> {
  await db.query(
    `INSERT INTO provider_undertakings (shop_id, university_id, user_id, version, text_sha256, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (shop_id, user_id, version) DO NOTHING`,
    [params.shopId, params.universityId, params.userId, params.version, params.textSha256, params.ip],
  );
  await db.query(`UPDATE shops SET undertaking_version = $2, undertaking_accepted_at = now(), updated_at = now() WHERE id = $1`, [params.shopId, params.version]);
}

/**
 * Stops a shop trading and withdraws what was proven about it. Used when a provider is
 * reported, leaves the university, or breaks the undertaking.
 */
export async function suspendProvider(db: Queryable, params: { shopId: string; by: string; reason: string }): Promise<void> {
  const { rows } = await db.query<{ status: string }>(`SELECT status FROM shops WHERE id = $1 FOR UPDATE`, [params.shopId]);
  if (!rows[0]) throw new NotFoundError("shop not found");
  await db.query(`UPDATE shops SET status = 'SUSPENDED', accepting_orders = false, updated_at = now() WHERE id = $1`, [params.shopId]);
  await db.query(
    `UPDATE provider_verifications SET status = 'REVOKED', decided_by = $2, decided_at = now(), note = $3 WHERE shop_id = $1 AND status = 'PASSED'`,
    [params.shopId, params.by, params.reason.slice(0, 1000)],
  );
}
