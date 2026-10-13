# PrintFlow

Campus printing without the queue. Students upload a document, choose how it should be
printed, see the exact price, pay, follow the job through the shop, and collect it with a
one-time pickup code. Print shops run their queue from the web or a phone. Universities
control pricing, shops and policy. Platform administrators oversee every university.

Built for Nigerian campuses:
- **Phone-first accounts**: sign up with a phone number, confirm it by SMS, sign in with a
  texted code, reset a password by text, and get a text when prints are ready (email works too).
- **Pay by card, bank transfer or USSD** through Paystack. Every payment is verified, so there
  are no fake transfer alerts.
- **Shop power status**: staff mark "Light on", "Generator on" or "Light out, back at 2pm", and
  students see it before they choose a shop.
- **Installable web app**: add it to the home screen from the browser; light on data, with
  an offline page.

This repository is the complete product: web app, mobile app, API, background worker,
database schema, tests, CI and deployment files.

> **Status, honestly:** the core product works end to end and is covered by automated tests
> (318 unit, integration and API tests, 40 browser tests across three screen sizes, a mobile smoke test and a load check).
> It has **not** been deployed, and several external integrations are built but unverified
> against the real services: Paystack payments (including bank transfer and USSD), Termii SMS
> (tested against a local fake gateway), ClamAV (tested against a protocol-accurate fake),
> S3 (MinIO/AWS), and container image builds. See
> [docs/TRACEABILITY.md](docs/TRACEABILITY.md) and [docs/QA_REPORT.md](docs/QA_REPORT.md)
> before treating it as production-ready.

## What's inside

| Path | What it is |
|---|---|
| `apps/web` | Next.js 15 web app: landing page (with a 3D printer and static fallbacks), and dashboards for students, shop staff, university admins and platform admins |
| `apps/mobile` | Expo (React Native) app for students and shop operators, including offline-safe queue actions |
| `apps/api` | NestJS API. All prices are computed here, never trusted from clients |
| `apps/worker` | Background jobs: malware scan, DOCX→PDF, page counting, previews, expiries, refunds, notifications, retention, privacy exports |
| `packages/pricing` | Pure pricing engine: integer kobo, versioned rate cards, two pricing modes |
| `packages/domain` | Order state machine, permissions, pickup codes, queue estimates |
| `packages/data` | Transactional data operations (order transitions, payments, refunds, jobs) |
| `packages/storage` | Private object storage (local disk or S3) with short-lived signed links |
| `packages/documents` | Upload inspection, ClamAV client, LibreOffice/qpdf/poppler pipeline |
| `packages/providers` | Payment providers (Paystack, Test) and email (SMTP, log) |
| `db` | PostgreSQL migrations, migration runner and schema tests |
| `docs` | Architecture, API, database, threat model, deployment, runbook, testing, QA |

## Quick start (development)

Requirements: Node 22, pnpm 10.28, PostgreSQL 16. For document conversion: LibreOffice,
qpdf and poppler-utils (`apt-get install libreoffice-writer-nogui qpdf poppler-utils`).

```bash
pnpm install
createdb printflow   # or use docker compose up postgres

export DATABASE_URL=postgres://printflow:printflow_dev@localhost:5432/printflow
pnpm db:migrate

# Development settings: simulated payments, no malware scanner, email printed to the log.
export SESSION_SECRET=$(openssl rand -base64 48) PICKUP_CODE_PEPPER=$(openssl rand -base64 48)
export MFA_ENCRYPTION_KEY=$(openssl rand -base64 32)
export STORAGE_DRIVER=LOCAL STORAGE_DIR=./storage-data STORAGE_SIGNING_SECRET=$(openssl rand -base64 48)
export PUBLIC_API_URL=http://localhost:3000/api PUBLIC_WEB_URL=http://localhost:3000
export PAYMENT_PROVIDER=TEST EMAIL_DRIVER=LOG SMS_DRIVER=LOG SCANNER=NONE   # nothing is really sent

DEMO_PASSWORD='choose-a-demo-password' pnpm db:seed   # sample university, shop and users
pnpm dev:api      # http://localhost:4000
pnpm dev:worker
pnpm dev:web      # http://localhost:3000
```

The seed creates clearly labelled sample data ("Demo University (sample data)") and five
accounts: `platform@`, `admin@`, `shop@`, `operator@` and `student@demo.printflow.test`, all
using `DEMO_PASSWORD`. Staff accounts are asked to set up two-factor authentication the
first time they sign in.

Outside production, every code and link the app would send is printed in the API and worker
terminals in a labelled box: email links (verification, password reset), SMS codes,
authenticator codes for staff two-step sign-in (at setup, at sign-in, and the right code
after a wrong one), checkout links and pickup codes. Set `DEV_CONSOLE=false` to turn it off.
Production refuses `DEV_CONSOLE=true` and never prints them.

Mobile: `cd apps/mobile && EXPO_PUBLIC_API_URL=http://<your-ip>:4000 npx expo start`.

## Checks

```bash
pnpm check          # lint + typecheck + every vitest suite (needs PostgreSQL)
pnpm test           # unit tests only
pnpm test:db        # database-backed tests (API, worker, schema)
```

Browser tests, the mobile smoke test and how to run the whole stack are in
[docs/TESTING.md](docs/TESTING.md).

## Documentation

- [Architecture](docs/ARCHITECTURE.md): components, request flow, order lifecycle, decisions
- [API guide](docs/API.md) and [OpenAPI spec](docs/openapi.json) (114 operations)
- [Database](docs/DATABASE.md): tables, invariants enforced in SQL, migrations
- [Threat model](docs/THREAT_MODEL.md): assets, threats, controls, known gaps
- [Deployment](docs/DEPLOYMENT.md) and [environment template](.env.example)
- [Runbook](docs/RUNBOOK.md): operating and recovering the system
- [Testing](docs/TESTING.md)
- [Traceability matrix](docs/TRACEABILITY.md): every requirement with an honest status
- [QA report](docs/QA_REPORT.md): what was tested, what was found and fixed, what remains

## Before going live

1. Configure Paystack keys, run the payment and refund flows against Paystack's test mode,
   then set `PAYMENTS_LIVE_ENABLED=true`. Checkout stays blocked until you do.
2. Run ClamAV (`SCANNER=CLAMAV`). The worker refuses to start in production without it.
3. Configure SMTP over TLS (production refuses log-only email) and Termii for SMS (or set
   `SMS_DRIVER=NONE` to launch without phone features). Enable bank transfer and USSD in
   the Paystack dashboard.
4. Build and run the container images on your infrastructure; they have not been built yet.
5. Have each university publish a real rate card. Students cannot check out against a
   shop with no published prices.
6. Commission an independent security review. None has been done.
