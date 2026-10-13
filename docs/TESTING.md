# Testing

| Suite | Command | Needs | What it covers |
|---|---|---|---|
| Unit | `pnpm test` | LibreOffice, qpdf, poppler for the documents tests | pricing engine, money, page ranges, order state machine, pickup codes, queue estimates, phone normalisation, SMS codes, power status, storage signing, upload inspection, the conversion pipeline, ClamAV protocol client, SMTP mailer, Termii client (fake gateway), Paystack checkout channels (fake API), the service worker (simulated network) |
| Database | `pnpm test:db` | PostgreSQL | schema guards and invariants, workflow (payments, refunds, concurrency), the full HTTP journey, security tests, configuration safety, worker jobs |
| Everything | `pnpm check` | both | lint + typecheck + all of the above |
| Browser | `pnpm --filter @printflow/web exec playwright test` | the running stack (below) | landing page (3D, reduced motion, no WebGL, axe), every dashboard screen for every role, the complete order journey through the UI, at desktop 1366×900, tablet 820×1180 and mobile (Pixel 7) |
| Load | `node apps/api/scripts/perf.mjs` | a running API with demo data, `RATE_LIMIT_SCALE` raised | latency percentiles and errors for shop discovery, order list, quote and price list under concurrent clients; fails over a p95 budget |
| Mobile | `node apps/mobile/scripts/web-smoke.mjs` | the running stack and the Expo web export (below) | student and operator screens, MFA enrolment, offline drafts and reconciliation, QA, collection with right and wrong codes |

## Database tests

The database tests create and drop their own databases. They never touch your development
data, and the helpers refuse any database whose name does not end in `_test`.

```bash
export TEST_DATABASE_URL=postgres://printflow:printflow_dev@localhost:5432/printflow_test
pnpm test:db
```

The API tests start the real Nest application in-process with:
- a fake ClamAV daemon that speaks the real `INSTREAM` protocol (and detects EICAR);
- the TEST payment provider, whose webhooks are signed and go through the real processing
  path;
- a capturing mailer.

## Running the stack for browser tests

```bash
export DATABASE_URL=postgres://printflow:printflow_dev@localhost:5432/printflow
export NODE_ENV=development PAYMENT_PROVIDER=TEST EMAIL_DRIVER=LOG SCANNER=NONE \
  SESSION_SECRET=… PICKUP_CODE_PEPPER=… MFA_ENCRYPTION_KEY=… \
  STORAGE_DRIVER=LOCAL STORAGE_DIR=/tmp/pf-storage STORAGE_SIGNING_SECRET=… \
  PUBLIC_API_URL=http://localhost:3000/api PUBLIC_WEB_URL=http://localhost:3000 \
  CORS_ORIGINS=http://localhost:3000,http://localhost:8081 \
  SMS_DRIVER=LOG E2E_API_LOG=/path/to/api.log \
  DEMO_PASSWORD=Demo-Password-2026 RATE_LIMIT_SCALE=20

pnpm db:migrate && pnpm db:seed
pnpm --filter @printflow/api --filter @printflow/worker build
API_ORIGIN=http://localhost:4000 pnpm --filter @printflow/web build

(cd apps/api && node dist/main.js &)
(cd apps/worker && POLL_INTERVAL_MS=500 node dist/main.js &)
(cd apps/web && NODE_ENV=production npx next start -p 3000 &)

pnpm --filter @printflow/web exec playwright test
```

`RATE_LIMIT_SCALE=20` is needed because the suite signs in many times from one address. The
production limits themselves are tested in `security.test.ts` at scale 1, and production
configuration refuses any other value.

Staff accounts need two-factor authentication. The helpers enrol it on first sign-in and
keep the secrets in `/tmp/pf-e2e-mfa.json`, so later runs (and the mobile smoke test) can
produce valid, never-replayed codes. Delete the file when you reset the database.

Phone tests read the texted codes from the API's log (the LOG SMS driver writes them there),
so start the API with its output going to the file named by `E2E_API_LOG`.

Playwright's offline emulation does not apply to requests a service worker makes, so the
worker's offline behaviour is unit-tested (`apps/web/test/sw.test.ts`) and the browser test
checks that it installs, takes control and caches only page shells.

Screenshots for every screen at every size are written to `docs/qa/screenshots/`.

## Mobile

```bash
cd apps/mobile
npx tsc --noEmit
npx expo export --platform android --output-dir dist-android   # Hermes bytecode bundle
EXPO_PUBLIC_API_URL=http://localhost:4000 npx expo export --platform web --output-dir dist-web
# serve dist-web on :8081 with an index.html fallback, then:
node scripts/web-smoke.mjs
```

The smoke test drives the react-native-web build at a 390×844 phone viewport. That checks
the app's logic and layout but is not a substitute for a device. Native behaviour (secure
storage, haptics, the document picker, NetInfo's native reachability, the system browser
for checkout) has **not** been tested on iOS or Android hardware or emulators.

## Load check

```bash
API=http://localhost:4000 DEMO_PASSWORD=… CONCURRENCY=20 DURATION_S=15 node apps/api/scripts/perf.mjs
```

This is a smoke-level performance test. It shows the hot paths have no pathological queries
and do not error under concurrency, but it is not capacity planning. Repeat it on
production-like hardware with production-sized data before launch. Run it against a separate
database from the browser tests: it uses the demo student's quote allowance, and the rate
limiter will (correctly) refuse that account's quotes for the rest of the hour. Latest results are in
the [QA report](QA_REPORT.md).

## Writing tests

- Prefer database-backed tests for anything involving money, state or permissions. The
  database is where most guarantees live.
- New API routes must be added to `ROUTE_DOCS` in `apps/api/src/openapi.ts`, or the
  OpenAPI test fails.
- When you fix a bug, add the test that would have caught it, and check that it fails
  without the fix.
