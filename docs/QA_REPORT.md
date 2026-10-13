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
