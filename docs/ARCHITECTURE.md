# Architecture

## Components

```
            students / shop staff / admins
                 │                    │
        ┌────────▼───────┐    ┌───────▼────────┐
        │  Web (Next.js) │    │ Mobile (Expo)  │
        │  /api/* proxy  │    │ bearer token   │
        └────────┬───────┘    └───────┬────────┘
     cookie +    │                    │
     CSRF token  ▼                    ▼
              ┌──────────────────────────────┐        ┌───────────────┐
              │          API (NestJS)        │◀──────▶│   Paystack    │
              │ auth · pricing · orders ·    │webhook │ (boundary;    │
              │ shop ops · admin · webhooks  │        │  unverified)  │
              └──────┬─────────────┬─────────┘        └───────────────┘
                     │             │ presigned / HMAC-signed links (≤300 s)
                     ▼             ▼
              ┌────────────┐  ┌───────────────────┐
              │ PostgreSQL │  │ Object storage     │
              │ (+ jobs    │  │ (S3 or local disk; │
              │  queue)    │  │  private)          │
              └─────▲──────┘  └─────────▲─────────┘
                    │ SKIP LOCKED       │
              ┌─────┴──────────────────┴──────┐      ┌─────────┐
              │            Worker              │─────▶│ ClamAV  │
              │ scan · convert · count · preview│      └─────────┘
              │ expire · refund · notify · purge│─────▶ SMTP relay
              └────────────────────────────────┘
```

- **Web**: Next.js 15 App Router. Every API call goes through the web origin
  (`/api/*` is rewritten to the API). Sessions are therefore first-party,
  HttpOnly, SameSite=Lax cookies, and writes carry a CSRF token. The landing page loads the
  3D scene (React Three Fiber) lazily. Visitors who prefer reduced motion, lack WebGL, have
  Data Saver on, are on a 2G connection or have under 2 GB of device memory get a static
  illustration instead.
- **Mobile**: Expo SDK 54. Students upload, quote, pay (in the system browser), track and
  show pickup codes. Shop operators run the queue, collect orders by code and report
  printer status. Mobile sessions use a bearer token kept in the device's secure storage,
  so no cookies and no CSRF are involved.
- **API**: NestJS 11 on Express 5. Stateless; scale horizontally behind a load balancer.
  Validates every input with zod, enforces tenancy and permissions in a single `Access`
  service, and writes an audit entry for every privileged action.
- **Worker**: a separate Node process that claims jobs from the `jobs` table with
  `FOR UPDATE SKIP LOCKED`, retries with exponential backoff and parks jobs as `DEAD` after
  their attempt limit. Periodic jobs (expiry sweeps, payment reconciliation, retention) are
  de-duplicated per time slot, so running several workers is safe.
- **PostgreSQL** is the system of record *and* the queue. Invariants that must never break
  (immutable quotes, frozen prices, append-only audit, refund caps, legal status transitions)
  are enforced by constraints and triggers, not only by application code.
- **Object storage** is private. The API stores objects under server-generated keys and
  hands out single-object links that expire within 300 seconds, after an access check.

## Request flow: student order

1. **Upload**: `POST /v1/documents` streams the raw body (≤ 50 MB) to storage while
   hashing it. The content is sniffed: only real PDF or DOCX is accepted, whatever the
   filename says. The API answers immediately with the document in `PENDING`.
2. **Scan and prepare** (worker): ClamAV `INSTREAM`; DOCX is checked for macros, zip bombs
   and path traversal, then converted by LibreOffice in a sandboxed subprocess with a
   timeout. qpdf normalises the PDF, pdf-lib counts pages, pdftoppm renders previews.
   The version becomes `READY`, `REJECTED` (malware or unsafe) or `FAILED`.
3. **Quote**: `POST /v1/quotes` resolves the governing rate card (see pricing), computes
   every line in integer kobo, and stores an immutable quote with a university-set expiry.
4. **Order**: `POST /v1/orders` (with an `Idempotency-Key`) pins the quote through a
   composite foreign key, so the order's price can never differ from the quote.
5. **Pay**: `POST /v1/orders/:id/payments` starts checkout with the provider and returns a
   redirect URL. Only a verified webhook (or reconciliation against the provider) can move
   the order to `PAID`; no client call can.
6. **Produce**: shop staff accept, print, record a quality check, and the job becomes
   `READY_FOR_PICKUP`. Each step is a guarded state transition with optimistic locking.
7. **Collect**: the student reveals a six-digit code (hashed with a server pepper and
   valid for 72 hours, 5 attempts). Staff enter it, and the order becomes `COLLECTED`.

## Order lifecycle

```
AWAITING_PAYMENT ──pay──▶ PAID ──accept──▶ ACCEPTED ──▶ PRINTING ⇄ PAUSED
   │        │              │                             │    ▲
 cancel   expire         reject ──▶ REJECTED ──┐   fail  ▼    │ retry / QA fail
   ▼        ▼              │                    │   PRINT_FAILED
CANCELLED EXPIRED     refund request            │        │
                           ▼                    ▼        ▼
                     REFUND_PENDING ◀───────────┴────────┘
                           ▼
                        REFUNDED
PRINTING ──▶ QUALITY_CHECK ──pass──▶ READY_FOR_PICKUP ──code──▶ COLLECTED
```

Who may make each move (actor type and shop permission) is declared once in
`packages/domain/src/order-state.ts`. The same table is mirrored in the database
(`order_status_transitions`), and a test fails if the two drift apart.

## Pricing

- Money is always an integer number of kobo. Fees are basis points, rounded half up.
  Floating point never touches a price.
- A university chooses one **pricing mode**:
  - `UNIVERSITY_CONTROLLED`: the university publishes rate cards; shops may receive
    per-shop overrides.
  - `MERCHANT_CONTROLLED`: each shop publishes its own rate card, which must sit inside
    price bounds agreed with the university. A card outside the bounds cannot be published
    or used.
- Rate cards are versioned and immutable once published. A new version takes effect from
  its `effective_from` date. Quotes record the card version they used, and confirmed orders
  never change price.
- There is no silent fallback: a shop with no effective card cannot quote, and checkout is
  blocked until real prices exist.

## Tenancy and authorization

Every tenant-owned row carries `university_id`. Foreign keys are composite
`(id, university_id)`, so a row can only reference rows in the same university. This holds
even if application code has a bug. On top of that, the `Access` service resolves the
caller's role:

- **Student**: own documents and orders only.
- **Shop staff**: one shop, with per-member permissions (`orders.accept`,
  `orders.produce`, `orders.qa`, `orders.collect`, `documents.download`, `devices.manage`,
  `catalogue.manage`, `pricing.manage`, `staff.manage`, `reports.view`, plus `orders.view`). Shops never see unpaid orders.
- **University admin**: one university.
- **Platform admin**: everything.

Staff and admin roles require an MFA-verified session.

## Key decisions

| Decision | Why |
|---|---|
| PostgreSQL as the job queue | One system to operate and back up; jobs enqueue in the same transaction as the state change that causes them, so none are lost or orphaned |
| Database-enforced invariants | Money and order state are too important to rely on every code path remembering the rules |
| Web proxies the API | First-party cookies, no third-party cookie problems, one origin for CSP |
| Bearer tokens on mobile | Secure storage on the device; no cookie jar or CSRF surface |
| Signed links ≤ 300 s, server-generated keys | Files are never public, never addressable by guessable names, and links leak little if shared |
| In-house TOTP | RFC 6238 is small. Secrets are encrypted with AES-256-GCM and replayed codes are rejected (`last_used_step`) |
| Offline drafts only for shop actions | Shop Wi-Fi drops. Drafts are clearly labelled as unsent, reconciled with optimistic versions, and conflicts are shown rather than overwritten. Collection and QA pass stay online-only because they notify students |
