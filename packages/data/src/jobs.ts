import type { Queryable } from "./tx.js";

export type JobKind =
  | "DOCUMENT_SCAN"
  | "DOCUMENT_PROCESS"
  | "NOTIFY"
  | "QUOTE_EXPIRE"
  | "ORDER_EXPIRE"
  | "RETENTION_PURGE"
  | "RECONCILE_PAYMENTS"
  | "REFUND_PROCESS"
  | "PRIVACY_EXPORT"
  | "PRIVACY_ERASE"
  | "PROVIDER_REVERIFY";

export interface JobRow {
  id: string;
  kind: JobKind;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export async function enqueueJob(
  db: Queryable,
  kind: JobKind,
  payload: Record<string, unknown>,
  opts: { dedupeKey?: string; runAfter?: Date; maxAttempts?: number } = {},
): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO jobs (kind, payload, dedupe_key, run_after, max_attempts)
     VALUES ($1, $2, $3, COALESCE($4, now()), COALESCE($5, 5))
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [kind, JSON.stringify(payload), opts.dedupeKey ?? null, opts.runAfter ?? null, opts.maxAttempts ?? null],
  );
  return rows[0]?.id ?? null;
}

/**
 * Claims up to `limit` runnable jobs for this worker. SKIP LOCKED lets several
 * workers poll the same table without blocking or double-claiming. Jobs whose
 * lease expired (worker crashed mid-job) become claimable again.
 */
export async function claimJobs(db: Queryable, workerId: string, kinds: readonly JobKind[], limit: number, leaseSeconds = 300): Promise<JobRow[]> {
  const { rows } = await db.query<JobRow>(
    `WITH next AS (
       SELECT id FROM jobs
        WHERE kind = ANY($2)
          AND ((status = 'QUEUED' AND run_after <= now()) OR (status = 'RUNNING' AND locked_until < now()))
        ORDER BY run_after, id
        LIMIT $3
        FOR UPDATE SKIP LOCKED)
     UPDATE jobs j SET status = 'RUNNING', locked_by = $1, locked_until = now() + make_interval(secs => $4), attempts = attempts + 1
       FROM next WHERE j.id = next.id
     RETURNING j.id, j.kind, j.payload, j.attempts, j.max_attempts`,
    [workerId, kinds, limit, leaseSeconds],
  );
  return rows;
}

export async function completeJob(db: Queryable, jobId: string): Promise<void> {
  await db.query(`UPDATE jobs SET status = 'SUCCEEDED', finished_at = now(), locked_by = NULL, locked_until = NULL WHERE id = $1`, [jobId]);
}

/** Exponential backoff (30s, 60s, 120s, ...) until max_attempts, then DEAD. */
export async function failJob(db: Queryable, job: Pick<JobRow, "id" | "attempts" | "max_attempts">, error: string, permanent = false): Promise<"RETRY" | "DEAD"> {
  const dead = permanent || job.attempts >= job.max_attempts;
  await db.query(
    `UPDATE jobs SET status = $2, last_error = $3, locked_by = NULL, locked_until = NULL,
            run_after = now() + make_interval(secs => $4), finished_at = CASE WHEN $2 = 'DEAD' THEN now() END
      WHERE id = $1`,
    [job.id, dead ? "DEAD" : "QUEUED", error.slice(0, 2000), 30 * 2 ** Math.max(0, job.attempts - 1)],
  );
  return dead ? "DEAD" : "RETRY";
}
