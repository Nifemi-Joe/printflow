# Runbook

Operating PrintFlow day to day and recovering when something breaks.

## Where to look

| Signal | Where |
|---|---|
| Service health | API `GET /v1/health`, `GET /v1/ready`; container health checks |
| Background work | Platform → Health: job counts by status, dead jobs, recent webhook failures (`GET /v1/platform/health`) |
| Provider webhooks | Platform → Webhooks (`GET /v1/platform/webhooks`) |
| Who did what | University → Audit log (append-only) |
| Logs | JSON on stdout (pino). Every request has `requestId`, also returned as `X-Request-Id` and shown to users in error messages |

Ship logs to your log platform and alert on:
- any job in `DEAD` status;
- webhook signature failures (more than a handful suggests misconfiguration or an attack);
- API 5xx rate above 1% for 5 minutes;
- `GET /v1/ready` failing;
- ClamAV unreachable (document jobs retrying with `scanner` errors);
- oldest `PENDING` job older than 10 minutes (workers stuck or too few).

## Common incidents

### Documents stuck in "Checking"
1. Platform → Health: are `DOCUMENT_PROCESS` jobs piling up or dead?
2. Worker logs for that job id. Typical causes:
   - **ClamAV down**: jobs retry with backoff; restart ClamAV. Dead jobs can be requeued
     (below).
   - **LibreOffice timeout** on a huge DOCX: the version is marked `FAILED` with a
     student-facing reason. Expected behaviour.
   - **Storage credentials** expired or rotated.
3. Requeue dead jobs after fixing the cause:
   ```sql
   UPDATE jobs SET status = 'PENDING', attempts = 0, run_after = now(), last_error = NULL
    WHERE status = 'DEAD' AND kind = 'DOCUMENT_PROCESS';
   ```

### A student paid but the order still says "Awaiting payment"
1. Find the order: University → Orders, search by reference.
2. Platform → Webhooks: did the provider event arrive? Was it verified?
   - **Not verified**: the Paystack secret key in the API config does not match the
     dashboard, or a proxy is altering the body. Fix it; the provider retries.
   - **Not received**: check the webhook URL in Paystack and firewall rules.
3. The worker's `RECONCILE_PAYMENTS` job checks pending payments against the provider. Wait
   for its next run, or trigger it by inserting a job:
   `INSERT INTO jobs (kind, payload) VALUES ('RECONCILE_PAYMENTS', '{}');`
4. Never mark an order paid by hand. The database will refuse a manual status jump, and it
   would bypass the amount check.

### Unpaid orders expired while the student was paying
The payment window is `PAYMENT_WINDOW_MINUTES`. If payment succeeds after expiry, the
webhook is recorded and the payment is refunded automatically. Tell the student to order
again.

### A refund is stuck in "Refund in progress"
- **The provider refused the refund** (refund status *Failed*, for example because the
  merchant balance was too low): fix the cause in the provider dashboard. Then a university
  admin opens the order in University → Orders and presses **Retry refund**. Only the
  unrefunded amount is sent, the database cap still applies, and the retry is audited
  (`refund.retried`).
- **The refund job errored** (network, provider outage): look at `REFUND_PROCESS` jobs and
  their `last_error`. They retry with backoff. If one went `DEAD`, requeue it once the
  provider is healthy. Refunds can never exceed the amount paid, so retrying is safe.

### A shop says the student's code doesn't work
- Codes expire after 72 hours and lock after 5 wrong attempts. The student can generate a
  new code in the app, which revokes the old one.
- The order must be *Ready for pickup* at **that** shop.

### A staff member lost their authenticator
1. Confirm their identity through a separate channel (video call with ID, a known phone
   number). Never reset on the strength of an email alone.
2. A platform admin uses Platform → **Reset two-factor authentication** with the person's
   email and how their identity was confirmed. Their authenticator is removed, every
   session is revoked, and the action is audited (`user.mfa_reset`, with the reason).
3. They sign in again and are asked to set up a new authenticator before they can reach
   any staff screen.

Platform admins cannot reset their own authenticator; another platform admin must do it.
Removing someone from a shop or university does **not** clear their authenticator.

### Students say the SMS code never arrives
1. API logs: look for `sms delivery failed` (the error says what Termii answered, e.g.
   insufficient balance or an unapproved sender ID). Top up or fix in the Termii dashboard.
2. Numbers on Do-Not-Disturb only receive codes on the DND route (`TERMII_CHANNEL=dnd`).
3. Students can always confirm by email instead, and sign in with their password.
4. A burst of texts to numbers nobody owns is SMS pumping: tighten limits or add a
   CAPTCHA (threat model T23).

### A shop's power status is wrong or out of date
Reports older than 6 hours are already shown as "may be out of date". Shop staff update
it from the queue (web) or Power & printers (app). Who reported what, and when, is in the
audit log (`shop.power_reported`).

### Suspected account compromise
1. Disable the user (`UPDATE users SET status = 'DISABLED' WHERE id = …`) and revoke
   sessions (`UPDATE sessions SET revoked_at = now() WHERE user_id = … AND revoked_at IS NULL`).
2. Review the audit log for their actions.
3. Rotate any secrets they could have seen.

## Routine operations

| Task | How |
|---|---|
| Deploy | See [DEPLOYMENT.md](DEPLOYMENT.md#4-release). Migrate first, then roll |
| Onboard a university | Platform → Universities → Onboard, then assign its admin |
| Approve a shop | University → Shops → Approve (shop applies from the web app) |
| Change prices | University → Pricing: draft a new version, publish with an effective date. Confirmed orders keep their price |
| Handle a privacy request | University → Privacy. Exports are produced by the worker; erasure waits until the student has no active orders |
| Retention | Automatic (worker, daily). Per-university `document_retention_days` |

## Backups and restore

- Use PostgreSQL point-in-time recovery; keep at least 30 days.
- Back up the bucket with object versioning, or replicate it to another region.
  Documents can be re-uploaded by students, but receipts reference stored data.
- **Restore drill (quarterly):** restore the latest backup to a scratch instance, run
  `node dist/migrate.js status` (all applied), and start an API against it in read-only
  mode to spot-check orders and payments.
- After a restore, payments made after the restore point exist at the provider but not in
  the database. Reconciliation (`PAYMENT_RECONCILE`) only re-checks known payments, so
  compare the provider's dashboard for that window by hand.

## Scaling

- **API**: stateless; add instances. Rate limits and sessions live in PostgreSQL.
- **Worker**: add instances, or raise `WORKER_CONCURRENCY`. LibreOffice conversion is the
  heaviest step (CPU and about 300 MB per conversion).
- **Database**: the hot tables are `orders`, `jobs`, `rate_limit_counters`. The worker
  prunes expired counters periodically.
