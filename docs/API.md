# API guide

The machine-readable contract is [openapi.json](openapi.json) (OpenAPI 3.1, 109 operations).
It is generated from the code (`pnpm openapi`). A test fails if any route is undocumented,
and CI fails if the committed file is out of date. This guide covers the conventions that
apply across endpoints.

Base path: `/v1`. The web app reaches it as `https://<web>/api/v1/...` (same origin); mobile
and server clients call the API host directly.

## Authentication

| Client | How | Writes need |
|---|---|---|
| Web | `POST /v1/auth/login` sets `pf_session` (HttpOnly, SameSite=Lax, Secure in production) | `X-CSRF-Token` header (from `GET /v1/auth/me`), and an allowed `Origin` |
| Mobile | `POST /v1/auth/login` with `"client": "mobile"` returns `sessionToken`; send `Authorization: Bearer <token>` | nothing extra |

- Student sessions last 14 days and staff sessions 12 hours. `logout-all` and password
  resets revoke every session.
- Staff, university-admin and platform routes require an **MFA-verified** session. Without
  one they answer `403 MFA_REQUIRED`. Enrol with `/auth/mfa/totp/setup` and `/confirm`, then
  verify each session with `/auth/mfa/verify`, or pass `mfaCode` at login.
- Login answers `401 INVALID_CREDENTIALS` identically for unknown emails, wrong passwords,
  locked and disabled accounts. Ten failures lock the account for 15 minutes.
- Sign in with `email` **or** `phone` (a phone works once it has been verified) plus `password`.

### Phone numbers and SMS codes

Phones are accepted in local Nigerian formats (`08012345678`, `8012345678`, `234…`) or E.164,
and are always stored and returned as E.164 (`+2348012345678`).

| Step | Endpoint |
|---|---|
| Add or change my number; a 6-digit code is texted | `POST /v1/me/phone` `{ phone }` |
| Confirm it | `POST /v1/me/phone/verify` `{ code }` |
| Text me a sign-in code | `POST /v1/auth/otp/request` `{ phone }` |
| Sign in with the code | `POST /v1/auth/otp/verify` `{ phone, code, client?, mfaCode? }` |
| Reset my password by text | `POST /v1/auth/password-reset/request` `{ phone }`, then `/confirm` `{ phone, code, newPassword }` |

- Codes last 10 minutes, burn after 5 wrong tries (`422 CODE_LOCKED`), work once, and a new
  code replaces the previous one. A code for one purpose (verify / sign in) or one number never
  works for another.
- `otp/request` and the phone reset request answer `202` with the same body whether or not
  the number has an account; texts are sent in the background.
- Registration accepts an optional `phone` and texts a verification code straight away.
- Ordering needs a **verified email or a verified phone** (`422 CONTACT_NOT_VERIFIED`).
- With `SMS_DRIVER=NONE` the phone endpoints answer `503 SMS_UNAVAILABLE`.

## Errors

Every error has the same shape:

```json
{ "error": { "code": "QUOTE_EXPIRED", "message": "this quote has expired; get a new price", "requestId": "…" } }
```

| Status | Meaning | Typical codes |
|---|---|---|
| 400 | Malformed input | `VALIDATION_FAILED` (with `details` per field) |
| 401 | Not signed in | `UNAUTHENTICATED`, `INVALID_CREDENTIALS` |
| 403 | Not allowed | `FORBIDDEN`, `CSRF_FAILED`, `MFA_REQUIRED`, `EMAIL_NOT_VERIFIED` |
| 404 | Not found *or not yours*: other tenants' resources are indistinguishable from missing ones | `NOT_FOUND` |
| 409 | Conflict | `STALE_VERSION`, `IDEMPOTENCY_MISMATCH`, `ALREADY_COLLECTED` |
| 410 | Gone | `QUOTE_EXPIRED` |
| 413 / 415 | Upload too large / not a PDF or DOCX by content | |
| 422 | Business rule | `INVALID_TRANSITION`, `PRICING_NOT_AVAILABLE`, `USE_DEDICATED_ACTION`, … |
| 429 | Rate limited; `Retry-After` header set | `RATE_LIMITED` |
| 503 | Dependency not configured | `CHECKOUT_DISABLED` |

Unexpected errors return `500 INTERNAL` with a request id and never include stack traces or
SQL. Every response carries `X-Request-Id`; quote it when reporting a problem.

## Idempotency and concurrency

- `POST /v1/orders` requires an `Idempotency-Key` header (16–128 characters of
  `[A-Za-z0-9_-]`). Retrying with the same key and body returns the original order.
  Reusing the key with a different body answers `409 IDEMPOTENCY_MISMATCH`. A request that
  failed does not consume its key.
- Shop transitions accept `expectedVersion`. If the order changed since the client read it,
  the call fails with `409 STALE_VERSION` instead of overwriting someone else's action.
- `POST /v1/shops/{id}/sync` applies actions drafted offline. Each action has a
  `clientActionId`, and replays return the stored result. Every action reports `APPLIED`,
  `CONFLICT` (with the current status) or `REJECTED`.

## Pagination

List endpoints take `limit` (1–100, default 25) and `cursor`. They return `nextCursor` while
more results exist. Cursors are keyset-based, so pages stay stable while new rows arrive.

## Money

All amounts are integers in **kobo** (`…Kobo` fields). Responses also include
display strings (for example `"₦1,234.50"`) for convenience. Clients must never compute
prices: `POST /v1/quotes` is the only source, and the amount charged is always the
quote's frozen total.

## Uploads

`POST /v1/documents` takes the file as the **raw request body** (not multipart):

```
POST /v1/documents
Content-Type: application/pdf            (or the DOCX MIME type)
Content-Length: 123456
X-Filename: lecture-notes.pdf            (URI-encoded)
X-Title: Week 3 notes                    (optional)
```

The response is `201` with `{ assetId, versionId, status: "PENDING" }`. Poll
`GET /v1/documents/{assetId}` until the version is `READY` (page count and previews
available), `REJECTED` or `FAILED` (with a `failureReason` written for students).

## File downloads

Previews, print files and privacy exports are never served from a public URL. An
endpoint checks access, then returns `{ url, expiresAt }`. The link works for at most 300
seconds and only for that object. With the S3 driver it is a presigned S3 URL; with the
local driver it is `/v1/files/{token}`, an HMAC-signed grant.

## Payment methods

Checkout offers card, bank transfer and USSD (the operator chooses which with
`PAYMENT_METHODS`). Quotes and order details list `paymentMethods`. Start checkout with
`POST /v1/orders/{id}/payments` `{ "method": "BANK_TRANSFER" }` (or omit `method` to offer all).
The method is passed to Paystack as `channels`, so the hosted checkout shows only that
option. The method actually used is recorded from the provider's webhook and returned as
`paidWith` on orders and receipts. An unoffered method answers `422 METHOD_UNAVAILABLE`.

## Shop power

Staff with `orders.produce` report power with `PUT /v1/shops/{id}/power`
`{ status: "GRID" | "GENERATOR" | "OUTAGE", backAt?, note? }`. `backAt` (only for `OUTAGE`)
must be within the next 48 hours. Shop listings and the staff queue return `power`:
`{ status, label, canPrint, backAt, overdue, note, updatedAt, stale, updatedBy }`. `stale`
is true after 6 hours without an update. It is always a staff report, never a sensor reading.

## Webhooks

- **Paystack**: `POST /v1/webhooks/paystack`, verified with HMAC-SHA512 of the raw body
  using your secret key (`x-paystack-signature`). Events are stored once by provider event
  id. Unverified or forged events are kept for inspection but never applied, and they cannot
  block the genuine event. The amount and currency must match the frozen order total.
  This integration is implemented but has **not** been exercised against Paystack.
- **Test provider** (`PAYMENT_PROVIDER=TEST`, refused in production):
  `/v1/test-payments/{reference}` shows a simulated checkout, and `/complete` sends a signed
  webhook through the same processing path.

## Rate limits

Limits are per fixed window, stored in PostgreSQL so they hold across API instances:

| Action | Limit |
|---|---|
| Login | 30 / 15 min per IP; 10 / 15 min per email or phone |
| SMS codes sent | 1 / minute and 5 / hour per number (applied to every number, known or not); 10 / hour per IP |
| SMS code checks | 10 / 15 min per number; 30 / 15 min per IP; 5 tries per code |
| Registration | 10 / hour per IP |
| Password reset request | 10 / hour per IP; 3 / hour per email |
| MFA verification | 10 / 5 min per user |
| Upload | 30 / hour per student |
| Quote | 120 / hour per student |
| Start payment | 20 / hour per student |
| Pickup code generation | 5 / hour per order |
| Collection attempts | 120 / min per shop (each code also locks after 5 wrong tries) |
| File downloads | 300 / min per IP |

## Endpoint groups

| Tag | Prefix | Who |
|---|---|---|
| System | `/health`, `/ready` | anyone (load balancers) |
| Auth | `/auth/*`, `/me/*` | anyone / signed in |
| Catalogue | `/universities`, `/shops/{id}/price-list` | anyone |
| Documents, Orders, Payments, Notifications, Privacy | `/documents`, `/quotes`, `/orders`, … | students |
| Shop | `/shops/{shopId}/*` | shop staff, by permission |
| University | `/admin/universities/{universityId}/*` | university admins |
| Platform | `/platform/*` | platform admins |
| Webhooks | `/webhooks/*` | payment providers (signature-checked) |
