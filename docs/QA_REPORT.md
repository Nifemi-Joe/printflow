# QA report

**Date:** 11 October 2026
**Scope:** everything in this repository at the commit that adds this report.
**Bottom line:** the product works end to end, and every automated suite passes. It is
**not production-ready** until the blocked items below are done: real payments, a real
malware scanner, built and deployed containers, an email relay, device testing and an
independent security review.

## Update: version 1 features (12 October 2026)

Added: installable web app, phone sign-up with SMS verification, SMS-code sign-in and
password reset, bank transfer and USSD checkout, and shop power status.

| Check | Result |
|---|---|
| Unit + database + API tests | **308 passed**, 0 failed (21 files; 67 new tests) |
| Browser tests (3 sizes) | **40 passed**, 8 skipped by design, 0 failed |
| Mobile smoke test | **25 of 25 checks passed** (now signs the student in with an SMS code) |
| Lint, typecheck, `pnpm audit --prod` (high+) | clean |
| Mutation checks | SMS-code attempt limit, service-worker API exclusion: both caught |

New defects found and fixed while building this:

| # | Defect | Fix |
|---|---|---|
| D17 | After Paystack checkout, students were sent to `/orders/{id}`, which does not exist in the web app (they would have seen "not found") | callback now `/student/orders/{id}` |
| D18 | The profile endpoint let anyone set any phone number with no proof of ownership | phone changes only through `/me/phone` with SMS verification; the profile endpoint ignores `phone` |
| D19 | The sign-up flow would ask for a second code immediately after texting the first, invalidating it | the verify page goes straight to code entry after sign-up |

Still not verified: real Termii delivery (tested against a local fake gateway only), Paystack
bank transfer/USSD channels against Paystack, PWA install on real Android/iOS devices.

## Update: development console (12 October 2026)

Outside production, codes and links (email links, SMS codes, authenticator codes, checkout
links, pickup codes) are printed to the API and worker terminals. Production refuses
`DEV_CONSOLE=true`.

| Check | Result |
|---|---|
| Unit + database + API tests | **318 passed**, 0 failed (23 files; 10 new tests) |
| Lint, typecheck | clean |
| Mutation check | forcing the console off fails 3 tests, as expected |
| Built API, development settings | reset-email link and SMS code printed in the terminal (checked by hand) |

Browser and mobile suites were not re-run for this change; it touches no UI.

## Update: sign-in "Request could not be verified" (12 October 2026)

| # | Defect | Fix | Test |
|---|---|---|---|
| D20 | Signing in failed with `CSRF_FAILED` when the browser still had an old session cookie (another tab, an MFA-pending session, an API restart), because the sign-in request was checked against that old session | sign-in, sign-up, SMS-code and password-reset routes ignore a leftover cookie; they still refuse foreign origins (login CSRF) | `sec` "signs in again even when the browser still holds an old session cookie" (fails without the fix) |
| D21 | Any page holding an old CSRF token failed every write until reloaded; sign-out failed silently and left people signed in | the web client fetches a fresh token and retries once | browser check: sign-out from a stale page returned 403 then 204, and the session ended |
| D22 | Opening the web app on 127.0.0.1, another port or a LAN address in development was refused | outside production, local and private-network origins are allowed; production still allows only `CORS_ORIGINS` and `PUBLIC_WEB_URL` | `cfg` origin tests |

In development the API terminal now explains every refused request (origin or token, and what to do).

| Check | Result |
|---|---|
| Unit + database + API tests | **321 passed**, 0 failed |
| Browser tests (3 sizes) | **40 passed**, 8 skipped by design, 0 failed |
| Lint, typecheck | clean |

## Update: staff two-step sign-in on the web (13 October 2026)

| # | Defect | Fix | Test |
|---|---|---|---|
| D23 | A new shop operator signing in from a link (`/login?next=/account`) skipped two-step sign-in: the link was followed before the MFA check | after sign-in, anyone with two-step sign-in pending goes to `/mfa` first, carrying the link; they continue to it afterwards | `e2e staff-mfa` |
| D24 | The Account page (and any page not marked "staff") could be opened with two-step sign-in still pending | every signed-in page sends them to `/mfa`, and no page content or data loads until it is done | `e2e staff-mfa` |
| D25 | From the Account page there was no link back to the shop when someone belonged to one workspace; "Account" appeared twice in the menu | the menu lists "Your workspaces" outside them; the duplicate item is gone | `e2e staff-mfa` |
| D26 | Operators saw Staff, Prices, Reports and Shop settings in the menu, which they cannot use | the shop menu shows only pages the person's permissions allow | `e2e staff-mfa` |
| D27 | `/shop` and `/admin` on their own were "not found" | they open the person's first shop or university | `e2e staff-mfa` |
| D28 | The two-step sign-in page had no way to sign out | sign-out link added | `e2e staff-mfa` |

| D29 | After one person signed out, the next person signing in on the same browser was sent to the previous person's last page ("University administrator access is required", "You are not a member of this shop") | sign-out no longer remembers the page; at sign-in a remembered page is followed only if this person can open it | `e2e staff-mfa` (reproduced by hand before the fix: sign-out landed on `/login?next=/student/documents`) |
| D30 | Opening another shop's or university's page showed raw API errors under a full menu | a plain "This page isn't part of your account" message with a link home and "Sign in as someone else" | `e2e staff-mfa` |
| D31 | A session that expired while a page was open left error boxes on screen | any "signed out" response re-checks the session and sends the person to sign in | `e2e staff-mfa` |

Browser tests: **42 passed**, 12 skipped by design, 0 failed. Lint and typecheck clean.

## Update: student wallet (14 October 2026)

Added a spend-only student wallet: top-ups by card, bank transfer or USSD; paying for
prints from the wallet alone or split with card/transfer/USSD; refunds to the wallet
(instant) or to the card/bank; university print credit and welcome credit; top-up and
low-balance texts. It cannot be withdrawn.

| Check | Result |
|---|---|
| Unit + database + API tests | **355 passed**, 0 failed (25 files; 33 new wallet tests, existing refund tests updated for the wallet default) |
| Browser tests (3 sizes) | **47 passed**, 16 skipped by design, 0 failed |
| Mobile smoke test | **30 checks passed** (wallet tab, pay from wallet, cancel returns money) |
| Lint, typecheck, `pnpm audit --prod` (high+) | clean (same 4 reviewed exceptions) |
| Mutation checks | removing the "paid in full" trigger, and spending cash before credit: both caught |

Defect found and fixed while building it:

| # | Defect | Fix |
|---|---|---|
| D32 | A wallet ledger insert skipped by `ON CONFLICT DO NOTHING` (a repeated welcome credit) still added to the balance, because the balance moved in a *before*-insert trigger | balance now moves in an *after*-insert trigger, which only fires for rows really inserted; covered by `wal-db` and `wal` |

Behaviour change: refunds of card/transfer/USSD money now go to the student's wallet by
default (instant). Students choose "back to my card or bank" when cancelling; admins choose
when refunding or resolving a dispute.

Still not verified: Paystack top-ups against Paystack; whether the wallet needs a licence
in Nigeria (see the threat model).

## Update: students who print for others (19 October 2026)

Students with their own printers can register as providers. What is proven about them
comes only from recorded checks, a shop's level is derived from those checks by the
database, and an unproven provider is held back from the list, capped per order and shown
with a warning the student has to accept.

| Check | Result |
|---|---|
| Unit + database + API tests | **376 passed**, 0 failed (26 files; 21 new provider tests) |
| Browser tests (3 sizes) | **52 passed**, 20 skipped by design, 0 failed |
| Lint, typecheck | clean |
| Mutation checks | removing the acknowledgement in the API, and the order cap in the database: both caught |
| Re-runnability | the provider browser suite was run twice in a row from the same demo data, with the same result |

Defects found and fixed while building this:

| # | Defect | Fix |
|---|---|---|
| D33 | The new database rules (student providers off, undertaking missing, acknowledgement missing, over the cap) surfaced to clients as 500s, because nothing mapped those error codes to HTTP | mapped to 409/422 with their own codes; covered by `pv` |
| D34 | Registering a shop makes you staff, so two-step sign-in kicked in immediately and dropped the new owner on an unexplained MFA screen, losing the verification page they were heading to | the destination is put in the address bar before the session refreshes, so the guard carries people back to it, and the MFA page says why a new shop owner is being asked | 
| D35 | Two fields on the provider review screen were both labelled "Note for the record", which is ambiguous for anyone using a screen reader | labelled "What did you check?" and "How did you confirm their identity?" |

Not verified: no real university has run the roll upload or the review queue; the
`STUDENT_ROLL_PEPPER` key has never been rotated in anger.

## Environment

All results come from one Linux sandbox (2 vCPUs): Node 22.22.0, pnpm 10.28.0,
PostgreSQL 16.15, LibreOffice 24.2.7, qpdf 11.9.0, poppler 24.02.0, Playwright 1.56.0
(Chromium with SwiftShader WebGL). Outbound network access was limited to package
registries, so Paystack, Docker Hub and any SMTP relay were unreachable.

## Results

| Check | Result |
|---|---|
| Lint (ESLint, whole repository) | 0 errors |
| Typecheck (6 packages, db, 4 apps) | 0 errors |
| Unit + database + API tests (vitest) | **241 passed**, 0 failed, 15 files |
| Browser tests (Playwright; desktop 1366×900, tablet 820×1180, Pixel 7) | **32 passed**, 4 skipped by design (the full journey runs once on desktop; the phone drawer test runs only at phone width), 0 failed |
| Accessibility (axe, inside the browser tests) | no violations on any tested page |
| Console errors and failed requests (asserted in every browser test) | none |
| Mobile app: typecheck, Android Hermes bundle, web bundle | pass |
| Mobile smoke test (react-native-web build, 390×844) | **18 of 18 checks passed** |
| Load check (20 clients, 15 s per scenario, one API process) | all passed, 0 errors; see below |
| Production build: API and worker bundles, web (Next standalone) | pass |
| OpenAPI | 109 operations; every route documented (tested) |
| Migrations | apply cleanly to an empty database; re-running reports up to date |
| Dependency audit (`pnpm audit --prod`, high and above) | pass, with 4 reviewed exceptions (Expo build tooling; [threat model §7](THREAT_MODEL.md#known-gaps-and-accepted-risks)) |
| Dockerfiles | `docker build --check` clean for all three; `docker compose config` valid; images **not built** (registry blocked) |
| CI workflow | `actionlint` clean; **not run on GitHub** |

### Load check

| Scenario | Requests | Throughput | p50 | p95 | p99 |
|---|---|---|---|---|---|
| Shops with queue estimates | 3,978 | 265/s | 70.7 ms | 109.7 ms | 154.8 ms |
| My orders (page of 25) | 7,292 | 486/s | 39.8 ms | 59.4 ms | 73.2 ms |
| Quote (server pricing) | 4,198 | 280/s | 70.1 ms | 95.8 ms | 116.5 ms |
| Price list | 8,052 | 537/s | 36.0 ms | 52.6 ms | 63.4 ms |

This is a smoke-level result on a small sandbox against a small dataset. It shows no
pathological queries and no errors under concurrency. It says nothing about capacity at
production scale.

### How we know the tests can fail

Passing tests only mean something if they catch breakage. These checks were deliberately
broken during QA and failed as expected, then were restored:
- one assertion in the HTTP journey;
- the production email guard;
- the refund-retry "already in progress" guard.

Every defect fix below also came with a test that fails without the fix.

## Defects found and fixed

| # | Severity | Defect | Fix | Test |
|---|---|---|---|---|
| D1 | High (security) | Shop staff could detect a student's **unpaid** order by probing the transition endpoint | shop scope excludes `AWAITING_PAYMENT` everywhere | `wf` "shops cannot see unpaid orders" |
| D2 | High (payments) | A **forged webhook** sent first could occupy the event id and suppress the genuine event | unverified events are stored under a unique id and never applied | `wf` "forged event cannot suppress the genuine one" |
| D3 | High (security) | **Next.js 15.5.4** had critical advisories (RCE in the flight protocol and image optimiser), SSRF and middleware bypasses; **multer**, **path-to-regexp** and **nodemailer** had DoS issues | upgraded to Next 15.5.27, Nest 11.2.6 (multer 2.4.0, path-to-regexp 8.4.2), nodemailer 10.0.10; postcss and sharp overrides | `pnpm audit`; full suites re-run |
| D4 | High (operations) | Production could only **log** emails (verification and reset links written to logs; users could never verify) | SMTP driver with TLS required; production refuses LOG and NONE | `mail-t`, `cfg`; end-to-end reset email through the built API |
| D5 | Medium (security) | Sending account email **synchronously** would let response time and SMTP errors reveal whether an account exists | the API sends account email in the background with retries; failures are logged without the body | `mail-t` |
| D6 | Medium (operations) | A refund the **provider refused** left the order stuck in "Refund in progress" with no way out | audited refund retry for the unrefunded remainder | `sec` refund retry |
| D7 | Medium (operations) | **No way to reset a lost authenticator**, and removing staff did not clear it | audited platform MFA reset that revokes sessions | `sec` MFA reset |
| D8 | Medium (API contract) | **Opening hours** were rejected unless all seven days were sent (zod 4 makes enum-keyed records exhaustive); the web form hid this by always sending seven days | `z.partialRecord` | `sec` shop hours test |
| D9 | Medium (mobile) | The Expo bundle failed to build: an optional peer of the web app's 3D library pulled **React Native 0.87** into the Expo SDK 54 tree | React, React DOM and React Native pinned workspace-wide | Android and web exports |
| D10 | Medium (mobile) | After reconnecting, the operator app **stayed offline** on web (NetInfo watches only `navigator.connection` there), and its reachability probe used a third-party URL that campus networks may block | reachability checked against the PrintFlow API; online/offline events re-checked | `m-smoke` reconnect and sync |
| D11 | Low (UX) | An operator without accept permission saw paid jobs with **blank action rows** and no explanation | "Waiting for a manager to accept this job" | `m-smoke` |
| D12 | Low (UX) | A card with an unsent offline draft still offered conflicting actions | actions hidden while a draft is pending, with undo above | `m-smoke` |
| D13 | Low (build) | Worker typecheck failed: its tests import the API harness, which uses decorators | tsconfig fix | `pnpm typecheck` |
| D14 | Low (UI) | Mobile web: 63 px horizontal overflow from screen-reader table headers; app bar stretched; long tables unreadable on phones; option chip styles leaked; scrollable tables not keyboard-focusable | layout and CSS fixes; stacked tables under 640 px; focusable labelled table regions | `e2e-*` overflow and axe checks |
| D15 | Low (UI) | The 3D sheet poked through the printer lid and was clipped at narrow widths | sheet path, camera and slot reworked | screenshots reviewed at 3 sizes |
| D16 | Low (web) | Public pages logged 401 errors to the console | `GET /v1/auth/session` probe | `e2e-landing` console assertions |

## Known limitations (not defects, not hidden)

| Area | State | What to do |
|---|---|---|
| Paystack | Implemented, **never run against Paystack**. Checkout is blocked until `PAYMENTS_LIVE_ENABLED=true` | Run charge, failure, refund and refund-failure flows in Paystack test mode |
| ClamAV | Tested only against a protocol-accurate fake daemon | Upload EICAR to the deployed scanner |
| S3 storage | Code complete; tested with the local driver only | Run the journey against MinIO or S3 |
| Email | Tested against an in-process SMTP server; no real relay | Send through your provider; set up SPF, DKIM and DMARC |
| Containers and CI | Dockerfiles linted and layouts run outside Docker; images not built; CI not run | Push to GitHub; CI builds the images |
| Mobile | Only the react-native-web build was exercised; no iOS or Android device, emulator or store build | Device testing; EAS builds |
| Mobile admin screens | University and platform admins get a read-only overview on mobile; management is web-only | By design for now |
| University onboarding form | Composes an email; there is no lead-capture backend | Point `NEXT_PUBLIC_ONBOARDING_EMAIL` at a monitored inbox |
| Backups | Procedure documented, never drilled | Run the restore drill in the runbook |
| Performance | Smoke-level load check on a 2-vCPU sandbox | Load test on production-like hardware and data |
| Security | Internal threat model and tests only | Independent penetration test |

## Test environment note

The browser suite and the mobile smoke test share the seeded demo accounts. After the load
check consumed the demo student's quote allowance, the browser journey was correctly
refused with "Too many requests" by the rate limiter. The suite passed once the counters
were cleared. Run the load check against a separate database ([TESTING.md](TESTING.md)).

## Screenshots

Under `docs/qa/screenshots/`:
- 82 web captures: landing hero, full page and reduced motion, plus every student, shop,
  university and platform screen, each at desktop, tablet and mobile;
- 9 mobile-app captures in `mobile/`.
