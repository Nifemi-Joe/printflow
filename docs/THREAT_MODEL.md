# Threat model

Scope: the PrintFlow web app, mobile app, API, worker, database and object storage as
built in this repository. Last reviewed with the code at the time of the QA report. This is
the development team's own analysis. **No independent security review or penetration test
has been carried out.**

## Assets

| Asset | Why it matters |
|---|---|
| Student documents | Coursework, theses and personal material; private by default |
| Money: payments, refunds, settlements | Direct financial loss; trust of students, shops and universities |
| Pickup codes | Whoever holds a valid code can collect someone else's print job |
| Accounts and sessions, especially staff and admin | Staff can move orders, see files and issue refunds; admins control pricing |
| Pricing configuration | Changing it changes what every student pays |
| Audit log | Evidence for disputes and investigations |
| Personal data (names, emails, campus details) | Privacy obligations (e.g. NDPR) |

## Actors

Anonymous visitors, students, shop operators/managers/owners, university admins, platform
admins, the payment provider (via webhooks), and attackers in any of those positions,
including a malicious student, a rogue shop employee and a compromised staff account.

## Threats and controls

| # | Threat | Controls | Evidence |
|---|---|---|---|
| T1 | Reading or acting on another tenant's data (IDOR) | Every query is scoped by the caller's role (`Access` service); composite `(id, university_id)` foreign keys make cross-tenant references impossible in SQL; other tenants' objects answer 404 | security tests: other students' orders, other shops' orders/files, admins confined to their university, platform routes |
| T2 | Shop staff exceeding their role | Per-member permission lists; staff cannot grant permissions they lack or change their own; shops never see unpaid orders | security tests; defect D1 in the QA report |
| T3 | Session theft and fixation | Random 256-bit tokens, stored only as SHA-256; HttpOnly, SameSite=Lax, Secure cookies; 14-day student and 12-hour staff lifetimes; revocation on logout-all and password reset | tests: cookie flags, reset signs out all sessions, no plaintext tokens in the DB |
| T4 | CSRF | Cookie-authenticated writes need an HMAC-derived CSRF token and an allowed `Origin`; mobile uses bearer tokens (no ambient credentials) | CSRF test |
| T5 | Credential stuffing and brute force | argon2id; generic login errors; lockout after 10 failures for 15 minutes; per-IP and per-email limits stored in Postgres (shared across instances); production refuses relaxed limits | lockout and rate-limit tests at production limits |
| T6 | Staff account takeover | TOTP MFA required for all staff and admin routes (refused in production config if disabled); secrets encrypted at rest; replayed codes rejected; MFA verification rate-limited | MFA tests |
| T7 | Marking an order paid without paying | Only verified webhooks or provider reconciliation can set `PAID`; amount and currency must equal the frozen total; the database refuses a payment amount that differs from the order total | "only the payment system can mark orders paid", "ignores client-supplied amount" |
| T8 | Forged or replayed webhooks | HMAC-SHA512 over the raw body; events de-duplicated by provider id; unverified events are stored under a unique id so a forged event cannot pre-empt the genuine one | defect D2 in the QA report; webhook tests |
| T9 | Price manipulation | Prices only from the server-side engine; quotes immutable and pinned to orders by composite key; published rate cards immutable; merchant prices bounded by university agreement | pricing tests; DB guards |
| T10 | Refund abuse or double refunds | Refunds capped at the amount paid with row locks; refunds final once settled; only admins or system paths can refund | forced concurrent-interleaving test |
| T11 | Pickup code guessing or reuse | 6-digit code stored as HMAC with a server pepper; 72-hour expiry; 5 wrong attempts burn the code; one use; per-shop collection rate limit; new codes revoke old ones | pickup tests; mobile smoke test (wrong code refused) |
| T12 | Malicious uploads (malware, macro documents, zip bombs, parser exploits) | Content sniffing (extension ignored); 50 MB cap; ClamAV `INSTREAM` before any processing; DOCX central-directory inspection for macros, encryption, path traversal and compression ratio; conversion in a separate process with a minimal environment, a throwaway profile, a hard timeout and process-group kill; only the normalised PDF is ever printed | EICAR, macro, oversize and non-document tests; timeout test |
| T13 | File leakage | Private storage; server-generated UUID keys; access-checked, single-object links valid for at most 300 seconds; download names sanitised; print-file links for staff audited and rate-limited | tampered/foreign/expired token tests |
| T14 | Injection (SQL, header, HTML) | Parameterised SQL only; zod validation on every input; React escaping; strict CSP on web (`default-src 'self'`) and `default-src 'none'` on the API; email subjects stripped of CR/LF | mailer header-injection test |
| T15 | Information disclosure through errors | Uniform error envelope; unexpected errors return a request id only; logs redact passwords, tokens and codes | "never leaks internals" test |
| T16 | Account enumeration | Identical login errors; password reset always returns the same response, and the email is sent in the background so timing and relay errors reveal nothing | reset tests; SMTP background mailer test |
| T17 | Lost or inconsistent state under concurrency | Row locks on order transitions; optimistic `expectedVersion`; idempotency keys for order creation and offline sync | conflict and idempotency tests |
| T18 | Privileged actions without accountability | Append-only, untruncatable audit log written in the same transaction as the action | audit test |
| T19 | Unsafe production configuration | Start-up refuses TEST payments, log-only or plaintext email, disabled MFA, insecure cookies, relaxed rate limits and a disabled scanner | config tests |
| T21 | Guessing or replaying SMS codes | 6-digit codes, 10-minute expiry, 5 tries per code then burned, single use, new code revokes old, HMAC bound to phone + purpose (a verification code cannot sign in), per-number and per-IP limits; phone sign-in only for verified numbers | `phone.test.ts` (lockout mutation-checked), domain OTP tests, DB guard |
| T22 | Discovering who is registered via phone flows | `otp/request` and phone reset return identical responses for every number; send limits apply to every number; texts are sent in the background so timing reveals nothing | `phone.test.ts` (unknown number: same body, no text) |
| T23 | SMS pumping / toll fraud (bots triggering paid texts) | 1 text per minute and 5 per hour per number, 10 per hour per IP; Nigerian numbers by default | partial: see gap 11 |
| T24 | Taking over an account by changing its phone | changing a phone requires being signed in, resets verification, and only a code sent to the new number confirms it; phone changes are impossible through the profile endpoint | `phone.test.ts` |
| T25 | Mislabelled payment method | the method shown on receipts comes only from the signed provider webhook; unsigned events change nothing | `checkout-power.test.ts` |
| T26 | False power reports | only staff with `orders.produce` at that shop can report; every report is audited with who and when; students see who reported and when, and old reports are marked out of date | `checkout-power.test.ts` |
| T27 | Creating wallet money (forged or replayed top-up, editing balances) | balances change only through ledger rows, enforced by triggers; a top-up is credited only from a signed provider event (or our own reconciliation call) whose amount matches; each top-up, refund and stray payment can be credited once (unique indexes) | `wal`, `wal-db` |
| T28 | Spending the same balance twice (double-click, two devices) | the wallet row is locked for every entry; one payment entry per order; balance cannot go below zero | `wal` race test, `wal-db` concurrent spends |
| T29 | Turning print credit into cash | credit is spent first, refunds return it as credit, revocation touches credit only, and there is no withdrawal at all | `wal`, `wal-db` |
| T30 | Staff abusing print credit | only university admin/finance can grant, per-grant cap (`PROMO_GRANT_MAX_KOBO`), Idempotency-Key, every grant and revocation audited with a reason the student sees | `wal` |
| T31 | Someone pretending to be a student to collect other students' documents | a student-run shop proves itself through recorded checks: a code to an address on the university's own mail domain, a matric number matched to the university's roll or confirmed by its staff, or an admin who met them. The level is derived by the database from those checks and cannot be set directly | `pv` (level cannot be written, one address per shop, one matric per shop), `pv-db` |
| T32 | A student unknowingly sending private documents to a stranger | a shop's standing is shown wherever one is chosen and on every order; below a verified matric number a student-run shop is left out of the list, capped per order, and the student must acknowledge the risk in words that say what the provider can see. The database refuses an unacknowledged or oversized order | `pv` (both refusals, and the database bypass), `e2e-pv` |
| T33 | A provider keeping, copying or selling documents they print | a versioned confidentiality undertaking must be accepted before any order can reach them; the wording's SHA-256 is stored with the acceptance, so a later edit cannot be passed off as what was signed. Reports are handled by suspending the provider, which closes the shop and withdraws everything proven about them | `pv` (no orders before acceptance, suspension), DB guard |
| T34 | A provider who has graduated or left still described as a current student | every passed check carries a renewal date; a worker job lapses them, which drops the level at once and tells the owner. A university can withdraw any check at any time | `pv` (renewal, withdrawal) |
| T35 | PrintFlow holding a copy of a university's student register | an uploaded roll keeps only the matric number and an HMAC of the surname, under a key held by the API; a roll is replaced wholesale, never merged, and the upload is audited by size only | `pv` (no name is stored) |
| T36 | A student-run shop used as a route to other students' documents at scale | the order cap bounds the value of any single job before a matric number is confirmed; the university sees every provider, how far each is proven and how many orders they have taken, and can stop any of them | `pv`, review screen |
| T20 | Denial of service | Request size limits; streamed uploads; rate limits; bounded worker concurrency and timeouts; jobs dead-lettered after their attempt limit | partial: see gaps |

## Known gaps and accepted risks

**Wallet regulation (not numbered, added with the wallet).** The wallet is closed-loop and
spend-only, which keeps it simpler than a withdrawable e-money balance. Whether it still
needs a licence or a licensed partner in Nigeria has not been checked with a lawyer or the
CBN. Students' wallet money sits in the operator's Paystack balance and should be tracked
as a liability (the university's Print credit page shows the totals). Get legal advice
before launch.

1. **No independent review.** Commission a penetration test before launch.
2. **Paystack integration unverified.** Signature checking and event mapping follow
   Paystack's documentation but have not been run against Paystack. Checkout stays disabled
   until `PAYMENTS_LIVE_ENABLED=true`. Verify charge, failure, refund and refund-failure
   webhooks in Paystack test mode first.
3. **ClamAV verified only against a protocol fake.** The real daemon was not available in
   development. Test with EICAR on the deployed scanner and keep signatures updated
   (`freshclam`).
4. **LibreOffice is a large parser surface.** It runs as a non-root user in a read-only
   container with a timeout. For stronger isolation, run conversion in a separate sandbox
   (gVisor, Firecracker or a dedicated conversion service) without database credentials.
5. **No CAPTCHA or bot defence** on registration and login beyond rate limits. Add one, or
   a WAF, if abuse appears.
6. **Volumetric DDoS** is out of scope for the application. Use a CDN or WAF in front of
   the web and API.
7. **Dependency advisories accepted for now.** These are Expo SDK 54 build tooling with no
   fixed release on that SDK: `braces` (GHSA-vfj7-8cjw-p6xm), `image-size`
   (GHSA-5p2g-fcmc-qvqq, GHSA-w3rx-r6r6-pgpr), `node-forge` (GHSA-86w9-cpqp-85rv). They are
   used by Metro and the Expo CLI at build time and are not shipped in the app or the
   servers. Moderate advisories remain in `decode-uri-component` (via expo-router's
   query-string; its fix is ESM-only and incompatible), `uuid` (Expo config plugins, build
   time) and `sprintf-js` (test tooling). Re-evaluate when upgrading Expo SDK.
8. **Printer status is self-reported** by staff, never read from devices, and is labelled
   that way everywhere it appears.
9. **The mobile web build** keeps the session token in memory only. It is a preview target,
   not a supported platform.
10. **Email deliverability** (SPF, DKIM, DMARC) depends on the SMTP provider you choose.
11. **SMS is a weaker factor than an authenticator app.** SIM swaps happen; staff still
    need TOTP MFA after an SMS sign-in. Watch Termii spend for pumping attacks and add a
    CAPTCHA before `otp/request` if it appears. The Termii integration has only been tested
    against a local fake gateway.
12. **The installable web app caches page shells** (no personal data, never the API, no
    query strings). On a shared computer, signing out still clears the session; cached
    shells reveal only which pages exist.
