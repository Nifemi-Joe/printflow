import { claimJobs, completeJob, enqueueJob, failJob, withTransaction, type JobKind, type JobRow } from "../../../packages/data/src/index.js";
import {
  documentGaveUp,
  expireOrder,
  PermanentJobError,
  privacyErase,
  privacyExport,
  processDocument,
  processRefund,
  purgeRetention,
  reconcilePayments,
  sendNotification,
  sweepExpiredOrders,
  type WorkerDeps,
} from "./handlers.js";

type Handler = (d: WorkerDeps, job: JobRow) => Promise<unknown>;

export const HANDLERS: Partial<Record<JobKind, Handler>> = {
  DOCUMENT_PROCESS: processDocument,
  ORDER_EXPIRE: expireOrder,
  REFUND_PROCESS: processRefund,
  NOTIFY: sendNotification,
  RETENTION_PURGE: (d, j) => purgeRetention(d, j),
  RECONCILE_PAYMENTS: (d) => reconcilePayments(d),
  PRIVACY_EXPORT: privacyExport,
  PRIVACY_ERASE: privacyErase,
};

/** Runs one job and records the outcome. Never throws. */
export async function runJob(d: WorkerDeps, job: JobRow): Promise<"SUCCEEDED" | "RETRY" | "DEAD"> {
  const handler = HANDLERS[job.kind];
  try {
    if (!handler) throw new PermanentJobError(`no handler for ${job.kind}`);
    await handler(d, job);
    await completeJob(d.pool, job.id);
    return "SUCCEEDED";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const outcome = await failJob(d.pool, job, msg, e instanceof PermanentJobError);
    d.log.warn({ jobId: job.id, kind: job.kind, attempt: job.attempts, outcome, error: msg }, "job failed");
    if (outcome === "DEAD" && job.kind === "DOCUMENT_PROCESS") await documentGaveUp(d, job, msg);
    return outcome;
  }
}

/** Claims and runs up to `limit` jobs once. Returns how many ran. */
export async function drainOnce(d: WorkerDeps, workerId: string, limit = 5): Promise<number> {
  const jobs = await withTransaction(d.pool, (c) => claimJobs(c, workerId, Object.keys(HANDLERS) as JobKind[], limit));
  for (const job of jobs) await runJob(d, job);
  return jobs.length;
}

/** Enqueues periodic maintenance, deduplicated per time slot so many workers don't duplicate it. */
export async function schedulePeriodic(d: WorkerDeps, now = new Date()): Promise<void> {
  const slot = (minutes: number) => new Date(Math.floor(now.getTime() / (minutes * 60_000)) * minutes * 60_000).toISOString();
  await enqueueJob(d.pool, "RETENTION_PURGE", {}, { dedupeKey: `purge:${slot(60)}` });
  await enqueueJob(d.pool, "RECONCILE_PAYMENTS", {}, { dedupeKey: `reconcile:${slot(15)}` });
  await sweepExpiredOrders(d);
  await d.pool.query(`DELETE FROM rate_limit_counters WHERE window_start < now() - interval '1 day'`);
  // SMS codes are useless once expired; keep a day for abuse investigations.
  await d.pool.query(`DELETE FROM phone_otps WHERE expires_at < now() - interval '1 day'`);
  await d.pool.query(`DELETE FROM jobs WHERE status IN ('SUCCEEDED') AND finished_at < now() - interval '14 days'`);
}

export async function runForever(d: WorkerDeps, opts: { workerId: string; pollMs: number; concurrency: number; scheduler: boolean; signal: AbortSignal }): Promise<void> {
  let lastSchedule = 0;
  while (!opts.signal.aborted) {
    try {
      if (opts.scheduler && Date.now() - lastSchedule > 60_000) {
        await schedulePeriodic(d);
        lastSchedule = Date.now();
      }
      const ran = await drainOnce(d, opts.workerId, opts.concurrency);
      if (ran === 0) await new Promise((r) => setTimeout(r, opts.pollMs));
    } catch (e) {
      d.log.error({ err: e }, "worker loop error");
      await new Promise((r) => setTimeout(r, opts.pollMs * 5));
    }
  }
}
