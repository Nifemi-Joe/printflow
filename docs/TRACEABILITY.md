# Requirements traceability

Every requirement from the PrintFlow brief, where it is implemented, what proves it, and
an honest status.

| Status | Meaning |
|---|---|
| **VERIFIED** | Implemented and exercised by automated tests that pass (and were shown to fail when the behaviour breaks, where noted in the QA report) |
| **IMPLEMENTED, NOT FULLY VERIFIED** | Built, but some part has not been exercised against the real thing (device, provider, infrastructure) or is only partly tested |
| **MOCKED** | Works only against a stand-in in this repository |
| **BLOCKED** | Cannot be done or verified without an external account, credential or infrastructure |
| **NOT IMPLEMENTED** | Not built |
| **FAILED** | Built but tests show it does not work |

Nothing is currently **FAILED**.

Test evidence abbreviations:
- `sec`: `apps/api/test/security.test.ts`
- `jour`: `apps/api/test/journey.test.ts`
- `cfg`: `apps/api/test/config.test.ts`
- `wf` / `schema`: `db/test/workflow.test.ts` / `db/test/schema.test.ts`
- `wkr`: `apps/worker/test/worker.test.ts`
- `docs-t`: `packages/documents/test/documents.test.ts`
- `price-t`: `packages/pricing/test/*`
- `dom-t`: `packages/domain/test/*`
- `stor-t`: `packages/storage/test/storage.test.ts`
- `mail-t`: `packages/providers/test/mailer.test.ts`
- `e2e-*`: `apps/web/e2e/*.spec.ts` (desktop, tablet, mobile)
- `m-smoke`: `apps/mobile/scripts/web-smoke.mjs`
- `perf`: `apps/api/scripts/perf.mjs`
- `phone`: `apps/api/test/phone.test.ts`
- `co-pw`: `apps/api/test/checkout-power.test.ts`
- `sms-t` / `pay-t`: `packages/providers/test/sms.test.ts` / `payments.test.ts`
- `sw-t`: `apps/web/test/sw.test.ts`
- `e2e-ppp`: `apps/web/e2e/phone-pay-power.spec.ts`

## Product scope and technology

| Requirement | Implementation | Evidence | Status |
|---|---|---|---|
| Independent product, own branding; no TeachNaija | whole repository | a case-insensitive search of the repository finds the name only in this matrix row | VERIFIED |
| TypeScript monorepo: Next.js, Expo, NestJS, PostgreSQL, migrations, private storage, workers | `apps/*`, `packages/*`, `db/` | builds and tests in CI | VERIFIED |
| Redis only when justified | not used: queue, rate limits and sessions live in PostgreSQL ([ARCHITECTURE](ARCHITECTURE.md#key-decisions)) | n/a | VERIFIED (decision) |
| OpenAPI | `apps/api/src/openapi.ts`, `docs/openapi.json` (109 operations) | `sec` "documents every route"; CI drift check | VERIFIED |
| CI | `.github/workflows/ci.yml` | `actionlint` clean; **never executed on GitHub** (no remote in this environment) | IMPLEMENTED, NOT FULLY VERIFIED |
| Docker | `apps/{api,worker,web}/Dockerfile`, `docker-compose.yml` | `docker build --check` clean; `docker compose config` valid; runtime layouts run outside Docker. **Images not built**: Docker Hub blocked | BLOCKED (build) |
| Structured logging | pino JSON with request ids and redaction (`apps/api/src/main.ts`, `apps/worker/src/main.ts`) | `sec` "never leaks internals" | VERIFIED |
| Deployment procedures | `docs/DEPLOYMENT.md`, `docs/RUNBOOK.md` | not rehearsed | IMPLEMENTED, NOT FULLY VERIFIED |
| Experiences for students, operators/owners, university admins, platform admins: **web** | `apps/web/app/{student,shop,admin,platform}` | `e2e-dashboards`, `e2e-journey` | VERIFIED |
| Same: **mobile** | students: full flow; shop operators: queue, collect, printers; university and platform admins: read-only overview on mobile, management on the web | `m-smoke` (react-native-web build) | IMPLEMENTED, NOT FULLY VERIFIED: no device or emulator testing; admin mobile is a summary only |

## Version 1 additions (October 2026)

| Requirement | Implementation | Evidence | Status |
|---|---|---|---|
| Usable, installable web app | `app/manifest.ts`, `public/sw.js`, `components/Pwa.tsx`, icons, `/offline` | `sw-t` (offline fallback, API never cached, no query strings, mutation-checked); `e2e-ppp` manifest, icons, worker control, cache contents at 3 sizes | VERIFIED (Chromium); not checked on real Android/iOS install |
| Phone number at sign-up, Nigerian formats | `packages/domain/src/phone.ts`, register schema | domain tests (local formats, invalid prefixes), `phone` | VERIFIED |
| SMS verification of the phone | `modules/phone.ts`, migration 0006 (`phone_otps` + guard) | `phone` (expiry, 5-try lockout mutation-checked, single use, number change), `e2e-ppp` sign-up flow, `m-smoke` | VERIFIED against the LOG/CAPTURE drivers |
| Email verification alongside phone | existing email links; ordering needs either | `phone` "a verified phone alone is enough", `sec` email flows | VERIFIED |
| Sign in with an SMS code; reset password by SMS; phone + password | `/auth/otp/*`, `/auth/login`, reset by phone | `phone` (enumeration-safe answers, replay refused, purpose binding), `e2e-ppp`, `m-smoke` | VERIFIED |
| Real SMS delivery (Termii) | `packages/providers/src/sms.ts` | `sms-t` against a local fake gateway; no real Termii account | BLOCKED (provider account) |
| "Your prints are ready" texts | worker `sendNotification` | `phone` (only "ready" texted, only to verified phones) | VERIFIED against CAPTURE driver |
| Bank transfer and USSD at checkout | `PAYMENT_METHODS`, `StartPayment`, Paystack `channels`, channel from webhook | `co-pw` (choice recorded, actual method from webhook, receipt label, unsigned event ignored, method switched off), `pay-t` (channels sent to fake Paystack), `e2e-ppp`, `m-smoke` | VERIFIED with the TEST provider; Paystack channels BLOCKED (no account) |
| Shop power status ("Light on / Generator on / Light out, back at 2pm") | migration 0006, `PUT /shops/:id/power`, catalogue + queue, web `PowerControl`, mobile Power & printers | domain power tests, `co-pw` (validation, permissions, audit), `e2e-ppp` (staff sets outage, student sees it), `m-smoke` | VERIFIED |

## Website and design

| Requirement | Implementation | Evidence | Status |
|---|---|---|---|
| Emerald, white, graphite, paper identity; premium responsive site | `apps/web/app/globals.css`, `landing.css` | screenshots at 3 sizes in `docs/qa/screenshots`; no horizontal overflow asserted | VERIFIED |
| Landing: 3D paper and printer, scroll-linked motion, layered layout, typography | `components/landing/PrinterScene.tsx`, `HeroVisual.tsx`, `app/page.tsx` | `e2e-landing` (3D loads with WebGL; scrolling stays native) | VERIFIED |
| Interactive product demo, pricing information, FAQs, CTAs | `PriceDemo.tsx`, pricing section, FAQ `<details>` | `e2e-landing` "price demo updates and labels itself as an example" | VERIFIED |
| University onboarding | `OnboardingForm.tsx` composes an email to `NEXT_PUBLIC_ONBOARDING_EMAIL`; platform admins onboard in the app | form rendering tested; there is no lead-capture backend | IMPLEMENTED, NOT FULLY VERIFIED |
| R3F only where appropriate, lazy loading, reduced motion, static fallbacks, slow networks | dynamic import; `canUse3D()` checks reduced motion, WebGL, Data Saver, 2G and device memory | `e2e-landing` reduced-motion and no-WebGL fallbacks | VERIFIED |
| No scroll hijacking | passive scroll listener only | `e2e-landing` | VERIFIED |
| Mobile: native navigation, touch, progress, skeletons, empty/error states, retry, accessible forms | `apps/mobile/components/ui.tsx`, screens | `m-smoke`; web screens covered by axe in `e2e-*` | IMPLEMENTED, NOT FULLY VERIFIED: no native screen-reader or device check |

## Student features

| Requirement | Implementation | Evidence | Status |
|---|---|---|---|
| Registration, authentication, recovery, profile | `modules/auth.ts` | `sec` auth group (lockout, reset, sessions, weak passwords), `e2e-journey` | VERIFIED |
| University, campus, department, pickup selection | register and profile; pickup chosen per order | `sec` departments test, foreign pickup point refused; `e2e-journey` | VERIFIED (web); mobile always uses a shop's first pickup point |
| Secure upload with progress, validation, retry | streamed raw-body upload; XHR progress (web and mobile) | `sec` type sniffing, 50 MB limit, EICAR; `e2e-journey` | VERIFIED |
| PDF and DOCX processing, conversion, page counting, preview | `packages/documents`, worker `processDocument` | `docs-t` with real LibreOffice, qpdf, poppler; `jour` preview | VERIFIED |
| Page ranges, copies, paper size, colour, sides | `packages/pricing/src/page-ranges.ts`, `quote.ts` | `price-t` (44 tests), `sec` invalid specs | VERIFIED |
| Binding and finishing | rate-card finishing per copy, sheet or order, by paper size | `price-t`, `jour` | VERIFIED |
| Exact server-generated quotes | `POST /v1/quotes` | `sec` "ignores any client-supplied amount" | VERIFIED |
| Shop discovery, availability, queue estimates | catalogue shops endpoint, `queue-estimate.ts` | `dom-t`, `sec` shop availability, `perf` | VERIFIED |
| Order history, document versions, receipts, notifications | orders, versions, receipt, notifications endpoints | `jour`, `sec` replacement versions, `e2e-dashboards` | VERIFIED |
| Payments, cancellation eligibility, refunds, disputes | `student-orders.ts`, `packages/data/src/payments.ts` | `sec` payments and refunds groups, `wf` | VERIFIED with the TEST provider; Paystack below |
| Live status and one-time pickup codes | order detail polling; `pickup-code.ts` | `dom-t`, `jour`, `m-smoke` | VERIFIED |
| Document replacement and reprint | versions endpoint; `reprintOfOrderId` | `sec` "replacement creates a new version", "reprint … not someone else's" | VERIFIED |

## Printer features

| Requirement | Implementation | Evidence | Status |
|---|---|---|---|
| Shop registration, approval, profile, hours, catalogue | `modules/shop.ts`, university shop status | `sec` hours and availability, `e2e-dashboards` | VERIFIED |
| Owner and staff accounts with granular permissions | memberships with permission lists | `sec` "cannot grant permissions they lack", operator limits | VERIFIED |
| Queue with authorised accept/reject | queue and transitions | `sec`, `jour`, `e2e-journey`, `m-smoke` | VERIFIED |
| Secure download of assigned files | audited, rate-limited document link | `sec` cross-shop file access, `documents.download` permission | VERIFIED |
| Production controls, pause/resume, failure reporting | transitions | `sec` printer failure test | VERIFIED |
| Printer availability, manually reported status | devices endpoints; labelled as staff-reported everywhere | `sec`, `m-smoke` printers screen | VERIFIED (never claims live status) |
| QA, reprints, mismatch reporting | quality checks; count mismatch forces a reprint | `sec` | VERIFIED |
| Ready notifications and collection verification | notifications, NOTIFY jobs, collect by code | `jour`, `sec`, `m-smoke` (wrong code refused) | VERIFIED in-app; email delivery below |
| History, revenue, turnaround, reconciliation | reports endpoints | `sec` reconciliation report test, `e2e-dashboards` | VERIFIED |
| Dashboards and audited staff actions | shop web dashboard; audit log | `sec` audit test, `e2e-dashboards` | VERIFIED |
| Offline-safe drafts, never falsely reported | `apps/mobile/lib/shop.ts`, `/sync` | `sec` sync test (conflicts, idempotency); `m-smoke` (server unchanged while offline, reconciled on reconnect) | VERIFIED on the web build; native NetInfo not device-tested |

## University administration

| Requirement | Implementation | Evidence | Status |
|---|---|---|---|
| University and campus management | admin campuses and departments; platform universities | `sec`, `e2e-dashboards` | VERIFIED |
| Shop approval, suspension, removal | shop status actions | `sec`, harness `openShop` | VERIFIED |
| Central price lists and versioned rate cards | `rate-card.ts`, `rate-card-write.ts` | `price-t`, `sec` "price changes never affect confirmed orders", retire fallback | VERIFIED |
| Shop-specific services and controlled overrides | `shop_price_overrides` | `sec` override applies to one shop and stops when revoked | VERIFIED |
| Effective dates, audit logs, transparent pricing | `effective_from`, audit log, public price list | `price-t`, `sec` | VERIFIED |
| Monitoring, disputes, refunds, reporting, staff permissions | `modules/university.ts` | `sec` dispute partial refund, refund retry, audit | VERIFIED |
| Tenant configuration, retention, privacy requests | settings; worker retention; privacy export and erase | `wkr` retention, `sec` privacy test | VERIFIED |

## Pricing engine

| Requirement | Implementation | Evidence | Status |
|---|---|---|---|
| Two explicit modes, no silent fallback | `resolvePricing` | `price-t`, `sec` merchant bounds | VERIFIED |
| Sizes, colour, sides, copies, finishing priced independently | rate card model | `price-t` | VERIFIED |
| Integer minor units | `money.ts` | `price-t` money tests | VERIFIED |
| Store applied rate-card version; freeze price | quote record; composite FK; DB guards | `schema`, `sec` | VERIFIED |
| Quote expiry, refunds, reprints, price changes before confirmation | quote TTL per university; DB guard | `sec` expired quote, price change tests | VERIFIED |
| Client calculations never authoritative | server quotes only | `sec` | VERIFIED |
| Block live checkout until real config exists | `checkoutMode()`; shops without a card cannot quote | `sec` "checkout is blocked…", `cfg` | VERIFIED |

## Backend and database

| Requirement | Implementation | Evidence | Status |
|---|---|---|---|
| Modular API: validation, authn/z, pagination, rate limits, documented errors, background jobs, safe transitions | `apps/api/src`, `packages/data` | `sec`, `wf`, `wkr` | VERIFIED |
| All listed entities | migrations 0001–0005 | `schema` | VERIFIED |
| FKs, tenant ownership, uniqueness, indexes, transactional money | composite FKs, guards | `schema`, `wf` incl. forced refund race | VERIFIED |
| No cross-university or cross-shop access | `Access` service and composite FKs | `sec` isolation tests | VERIFIED |
| Jobs bound to an immutable version and hash | `document_version_id` + `print_sha256`; version guard | `schema` | VERIFIED |

## Security

| Requirement | Implementation | Evidence | Status |
|---|---|---|---|
| Auth, recovery, sessions, privileged MFA | argon2id, hashed tokens, TOTP; audited MFA reset | `sec` | VERIFIED |
| Role-based, tenant-aware authorisation | `Access` | `sec` | VERIFIED |
| IDOR/BOLA, escalation, injection, XSS, CSRF, SSRF, path traversal | scoped queries, permission caps, parameterised SQL, CSP and React escaping, CSRF tokens, no user-supplied server-side fetches, key validation | `sec`, `stor-t`, `docs-t` traversal; no dedicated XSS or SSRF fuzzing | IMPLEMENTED, NOT FULLY VERIFIED: no independent penetration test |
| Private storage, short-lived scoped links | `packages/storage` | `stor-t`, `sec` tampered/expired tokens | VERIFIED (local driver); S3 driver **not run against S3 or MinIO** |
| Malware scanning | ClamAV INSTREAM client | `docs-t`, `sec` against a protocol-accurate fake daemon | MOCKED (real ClamAV unavailable here) |
| Sandboxed processing, signatures, size, page limits, timeouts | `process.ts`, `sniff.ts` (50 MB, 2,000 pages) | `docs-t` timeout and sniffing, `sec` | VERIFIED (process isolation; see threat model gap 4) |
| Encryption in transit and at rest | TLS at the proxy; Secure cookies; SMTP TLS required; storage and DB encryption are infrastructure settings | `cfg` | BLOCKED (no infrastructure) |
| Signed webhooks, idempotency, reconciliation | `payments.ts`, reconcile job | `sec` forged/duplicate webhooks, idempotency | VERIFIED for signature logic; Paystack below |
| Paystack payments and refunds | `packages/providers/src/payments.ts` | none against Paystack | BLOCKED (no account; network blocked) |
| Pickup expiry, attempt limits, replay prevention | `pickup-code.ts`, DB guard | `dom-t`, `sec`, `m-smoke` | VERIFIED |
| Secrets management, dependency scanning | env-only secrets with start-up validation; `pnpm audit` in CI with reviewed exceptions | `cfg`; audit clean at high level | VERIFIED (secret *storage* depends on deployment) |
| Redacted logs, privacy controls, retention, tested backups | pino redaction; privacy requests; retention job; backup procedure | `wkr`, `sec`; **backups not tested** | IMPLEMENTED, NOT FULLY VERIFIED |
| Email (verification, reset, notifications) | SMTP driver with TLS; background sending in the API | `mail-t` against a real SMTP server implementation; built API delivered a reset email end to end; no real relay | IMPLEMENTED, NOT FULLY VERIFIED |

## Testing

| Requirement | Evidence | Status |
|---|---|---|
| Unit, integration, API, e2e, security, accessibility | 308 vitest tests; 40 Playwright tests ×3 sizes with axe; mobile smoke (25 checks) | VERIFIED |
| Performance | `perf` load check (four hot paths, p95 budget) | IMPLEMENTED, NOT FULLY VERIFIED: sandbox hardware only, no production-scale data |
| Full journey | `jour` (HTTP) and `e2e-journey` (UI) | VERIFIED |
| Invalid files, expired quotes, payment failures, duplicate webhooks, failed printers, refunds, duplicate collection, queue concurrency, tenant isolation, unauthorised file access | `sec`, `wf` | VERIFIED |
| Lint, typecheck, migration checks, builds, security scans | `pnpm check`, CI jobs, `pnpm audit` | VERIFIED locally; CI not yet run on GitHub |
| Inspect browsers at mobile, tablet, desktop: console, failed requests, 3D fallbacks, reduced motion, a11y | `e2e-*` assert zero console errors and failed requests; screenshots reviewed | VERIFIED |

## Documentation

| Deliverable | Location | Status |
|---|---|---|
| README | `README.md` | VERIFIED (present, accurate to code) |
| Architecture | `docs/ARCHITECTURE.md` | VERIFIED |
| API specification | `docs/openapi.json`, `docs/API.md` | VERIFIED |
| Database documentation | `docs/DATABASE.md` | VERIFIED |
| Threat model | `docs/THREAT_MODEL.md` | VERIFIED |
| Deployment guide | `docs/DEPLOYMENT.md` | IMPLEMENTED, NOT FULLY VERIFIED (not rehearsed) |
| Environment template | `.env.example` | VERIFIED (validated by compose config; variables match config schemas) |
| CI configuration | `.github/workflows/ci.yml` | IMPLEMENTED, NOT FULLY VERIFIED |
| Migrations | `db/migrations` | VERIFIED |
| Test instructions | `docs/TESTING.md` | VERIFIED |
| Runbook | `docs/RUNBOOK.md` | IMPLEMENTED, NOT FULLY VERIFIED (procedures not drilled) |
| QA report | `docs/QA_REPORT.md` | VERIFIED |
