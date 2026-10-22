# Database

PostgreSQL 16. The schema lives in `db/migrations` as plain SQL files applied in order by
`db/scripts/migrate.ts`. The runner takes an advisory lock, so two deploys cannot migrate at
once. It also records a checksum per file, so an edited, already-applied migration is
refused rather than silently ignored.

```bash
pnpm db:migrate          # apply pending migrations (dev; uses tsx)
pnpm db:status           # applied / pending
node dist/migrate.js up  # inside the API image (MIGRATIONS_DIR=/app/db/migrations)
```

Never edit an applied migration; add a new one.

## Migrations

| File | Contents |
|---|---|
| `0001_identity_and_tenancy.sql` | universities, campuses, departments, users, student profiles, sessions, MFA factors, recovery tokens, university staff, shops, pickup locations, shop memberships, devices, audit log |
| `0002_pricing.sql` | rate cards (versioned), sheet prices, finishing options, price bounds, per-shop overrides |
| `0003_documents_quotes_orders.sql` | document assets and versions, jobs, quotes, orders, legal status transitions, order events, queue entries, quality checks, pickup tokens |
| `0004_payments_and_disputes.sql` | payments, provider webhook events, refunds, disputes, settlements, idempotency keys |
| `0005_api_support.sql` | login lockout fields, preview/scan metadata, reprint link, additional job kinds, notifications, privacy requests, rate-limit counters |
| `0006_phone_payments_power.sql` | phone verification, one-time SMS codes (`phone_otps`), requested and actual payment channel, shop power status |
| `0007_wallet.sql` | student wallets, the wallet ledger, top-ups, refund destination, welcome credit, "paid in full" check on orders |
| `0008_student_providers.sql` | shop kind and verification level, the verification trail, student roll, confidentiality undertakings, provider email codes, order limits for unverified providers |

## Tables by area

- **Tenancy and identity:** `universities`, `campuses`, `departments`, `users`,
  `student_profiles`, `university_staff`, `sessions` (SHA-256 token hashes only),
  `mfa_factors` (TOTP secrets encrypted with AES-256-GCM), `account_recovery_tokens`
  (hashed), `phone_otps` (SMS codes: HMAC only, bound to phone and purpose).
- **Shops:** `shops` (including reported power status), `pickup_locations`, `shop_memberships` (role plus explicit permission
  list), `devices` (manually reported status).
- **Pricing:** `rate_cards`, `rate_card_sheet_prices`, `rate_card_finishing`,
  `price_bounds`, `shop_price_overrides`.
- **Documents:** `document_assets`, `document_versions` (scan result, page count, storage
  keys, preview count, retention purge time).
- **Ordering:** `quotes`, `orders`, `order_status_transitions` (the legal state machine as
  data), `order_events` (timeline), `queue_entries`, `quality_checks`, `pickup_tokens`
  (HMAC of the code only).
- **Money:** `payments`, `payment_webhook_events`, `refunds` (to the provider or the
  wallet), `disputes`, `settlements`.
- **Who runs a shop:** `provider_verifications` (one row per identity check, with its
  evidence and renewal date), `provider_undertakings` (confidentiality undertakings
  accepted, with the wording's hash), `provider_email_codes` (one-time codes to a
  provider's student email, HMAC only), `university_student_roll` (matric number plus a
  keyed hash of the surname; no names).
- **Wallet:** `wallets` (cash and print-credit balances, one per student),
  `wallet_entries` (append-only ledger; every balance change is one row),
  `wallet_topups` (provider payments into the wallet).
- **Platform:** `jobs` (the work queue), `idempotency_keys`, `notifications`,
  `privacy_requests`, `audit_log`, `rate_limit_counters` (UNLOGGED: counters are cheap to
  lose on a crash).

## Invariants enforced by the database

These hold even if application code is wrong. Each has a test in `db/test/schema.test.ts`,
`db/test/workflow.test.ts` or `db/test/wallet.test.ts`.

| Invariant | Mechanism |
|---|---|
| A row can only reference rows in the same university | Composite foreign keys on `(id, university_id)` |
| Orders start `AWAITING_PAYMENT` and only move along legal transitions | `orders_insert_guard`, `orders_update_guard` checking `order_status_transitions` |
| An order's price, quote, document and shop never change after creation | `orders_update_guard` ("terms are frozen") |
| An order uses an unexpired quote, from a shop accepting orders, for a printable document version | insert guard |
| Quotes are immutable | `quotes_immutable` |
| Published rate cards and their lines are immutable and undeletable | `rate_cards_guard`, line guards |
| Processed document versions are immutable | `document_versions_guard` |
| Payment amount equals the order total; payments are final once settled | `payments_guard`, check constraints |
| Refunds can never exceed what was paid, even under concurrent requests | `refunds_cap` with row locks (tested with a forced interleaving) |
| A pickup token is spent once, expires, and its hash cannot be changed | `pickup_tokens_guard` |
| The audit log and order timeline are append-only; the audit log cannot be truncated | `audit_log_append_only`, `audit_log_no_truncate`, `order_events_append_only` |
| Orders, payments and refunds are never deleted | `*_no_delete` triggers |
| `row_version` (optimistic locking) is managed by the database | update guard |
| An SMS code is used once, cannot be used after expiry, revocation or its attempt limit, and its hash and phone cannot change | `phone_otps_guard` |
| A phone can only be marked verified while one is set | `users_phone_verified_needs_phone` |
| An expected power return time only exists during an outage | `shops_power_back_only_when_out` |
| Wallet balances change only through ledger entries, never go negative, and stay under a hard ceiling | `wallets_guard`, check constraints, `wallet_entries_check` / `wallet_entries_post` |
| A ledger entry skipped by `ON CONFLICT DO NOTHING` never moves a balance | balance is updated in an `AFTER INSERT` trigger |
| Each top-up, card refund, stray payment and order payment is credited at most once, and must match its source exactly | partial unique indexes; source checks in `wallet_entries_check` |
| An order can only take from the wallet while awaiting payment, never more than its total; returns never exceed what it took, per bucket | `wallet_entries_check` |
| A card/transfer payment equals the order total minus the wallet part | `payments_guard` |
| An order becomes `PAID` only when provider money plus wallet money equals its total | `orders_paid_in_full` |
| A refund to the wallet is recorded complete at once | `refunds_wallet_is_instant` |
| A shop's verification level always equals what its passed checks say; it cannot be set directly | `provider_verifications_level`, `shops_provider_guard` |
| A shop's kind is fixed at registration | `shops_provider_guard` |
| What a verification check covers never changes, and a decided check can only lapse or be withdrawn | `provider_verifications_guard` |
| At most one live check of each kind per shop | `provider_verifications_one_live` |
| A student-run shop exists only where the university allows them, and takes no orders until the owner accepts the confidentiality undertaking | `shops_provider_guard` |
| An order at a student-run shop below `MATRIC_VERIFIED` needs the student's acknowledgement and stays under the university's cap | `orders_insert_guard` |

## Money

Every amount is `bigint` kobo with `CHECK (… >= 0)`. Totals are stored, not recomputed.
Quotes keep their full line breakdown as JSON next to the integer totals.

## Jobs

`jobs(kind, payload, status, attempts, max_attempts, run_after, locked_by, locked_until,
last_error)`. Workers claim work with `FOR UPDATE SKIP LOCKED` and a lease. Failures retry
after 30·2ⁿ⁻¹ seconds. Jobs that exhaust their attempts become `DEAD` and appear on the
platform health page. Jobs are inserted in the same transaction as the change that causes
them.

## Retention

Each university sets `document_retention_days`. The worker deletes stored files once every
order using a document version has finished *and* the retention period has passed (or the
student deleted the document, or it was rejected). It keeps the metadata needed for
receipts and audit. Privacy erasure anonymises the user and deletes their files once they
have no active orders.

## Backups

See [RUNBOOK.md](RUNBOOK.md#backups-and-restore). Use point-in-time recovery (WAL
archiving) in production. The database holds money records that must not be lost.
