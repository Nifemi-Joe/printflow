# Deployment

> The container images and this procedure have **not** been run end to end. In the
> development environment the Dockerfiles pass `docker build --check`, and the exact runtime
> layouts were run outside Docker (bundled API, worker and migrator with production-only
> dependencies; Next.js standalone server). Building the images was impossible there because
> Docker Hub is blocked. CI builds all three images on every push; treat the first
> deployment as a rehearsal.

## What you run

| Service | Image | Scale | Needs |
|---|---|---|---|
| `api` | `apps/api/Dockerfile` | 2+ instances behind a load balancer | PostgreSQL, object storage, SMTP, Paystack |
| `worker` | `apps/worker/Dockerfile` | 1+ (more for conversion throughput) | PostgreSQL, object storage, ClamAV, SMTP, Paystack |
| `web` | `apps/web/Dockerfile` | 2+ | the API (internal URL, set at build time) |
| migrations | the API image, `node dist/migrate.js up` | once per release, before new API pods | PostgreSQL |
| PostgreSQL 16 | managed service recommended | primary + PITR backups | |
| Object storage | S3 or any S3-compatible store | one private bucket | |
| ClamAV | `clamav/clamav:stable` | 1+ | signature updates (built into the image) |

All application containers run as the unprivileged `node` user and are designed for a
read-only root filesystem with a writable `/tmp`.

## 1. Prepare infrastructure

1. **PostgreSQL 16** with automated backups and point-in-time recovery. Create a database
   and a role that owns it. The application needs DDL rights only while migrating.
2. **Bucket**: private, with no public ACLs or policies and server-side encryption on. Give
   the API and worker an access key limited to that bucket (`GetObject`, `PutObject`,
   `DeleteObject`, `HeadObject`).
3. **SMTP relay** with TLS (port 465 or STARTTLS on 587). Configure SPF, DKIM and DMARC for
   the sending domain.
4. **SMS (Termii)**: create an account, register a sender ID (e.g. "PrintFlow") and request
   the DND route so codes reach numbers on Do-Not-Disturb. Set `SMS_DRIVER=TERMII`,
   `TERMII_API_KEY`, `TERMII_SENDER_ID` and your account's `TERMII_BASE_URL`. Set
   `SMS_DRIVER=NONE` to launch without phone features.
5. **Paystack**: create the account and keys, and enable the Bank Transfer and USSD
   channels in the dashboard (they must also be listed in `PAYMENT_METHODS`). Point the webhook URL to
   `https://<api-host>/v1/webhooks/paystack`.
6. **TLS termination** (load balancer or reverse proxy) for the web and API hosts. Forward
   `X-Forwarded-For` from exactly one proxy and set `TRUST_PROXY=true`.

## 2. Configure

Copy [`.env.example`](../.env.example) into your secret store. Generate secrets with
`openssl rand -base64 48` (and `openssl rand -base64 32` for `MFA_ENCRYPTION_KEY`). Store
them in a secrets manager, never in the image or repository.

The services validate their configuration at start-up and **refuse to start in production**
in any of these cases:

- payment provider `TEST`, or live payments enabled without a Paystack key;
- `SMS_DRIVER` `LOG` or `CAPTURE` (codes would land in logs), or `TERMII` without a key or sender ID;
- `EMAIL_DRIVER` other than `SMTP`, or SMTP without TLS;
- staff MFA disabled, insecure cookies, or `RATE_LIMIT_SCALE` other than 1;
- malware scanning disabled (worker);
- short secrets or an MFA key that is not 32 bytes.

Losing `MFA_ENCRYPTION_KEY` makes enrolled authenticators unusable, and staff must
re-enrol. Rotating `SESSION_SECRET` invalidates CSRF tokens; sessions survive, but browsers
must reload. Rotating `PICKUP_CODE_PEPPER` invalidates outstanding pickup codes; students
can generate new ones.

## 3. Build

```bash
docker build -f apps/api/Dockerfile    -t registry.example/printflow-api:$REV .
docker build -f apps/worker/Dockerfile -t registry.example/printflow-worker:$REV .
docker build -f apps/web/Dockerfile    -t registry.example/printflow-web:$REV \
  --build-arg API_ORIGIN=http://printflow-api.internal:4000 \
  --build-arg NEXT_PUBLIC_ONBOARDING_EMAIL=partnerships@example.com .
```

`API_ORIGIN` is compiled into the web app's `/api/*` rewrite, so build the web image per
environment.

The mobile app is built with EAS or `npx expo prebuild` plus the native toolchains. Set
`EXPO_PUBLIC_API_URL` to the public API URL. Store builds and signing were not done in
this repository.

## 4. Release

1. Run migrations: `docker run --rm --env-file prod.env printflow-api:$REV node dist/migrate.js up`.
   Migrations are additive. Roll the application forward after they succeed.
2. Roll out `api` and `worker`, then `web`. Health checks: `GET /v1/health` (liveness) and
   `GET /v1/ready` (checks the database) on the API; `GET /` on the web.
3. Smoke test: sign in as a platform admin and check **Platform → Health** (no dead jobs;
   checkout mode is what you expect). Upload a small PDF as a test student and confirm it
   reaches *Ready*, which proves storage, ClamAV and the conversion tools are working.

## 5. Go live checklist

- [ ] Paystack test mode: successful charge, failed charge, refund, refund failure. Confirm
      each webhook is verified and applied (Platform → Webhooks). Then set
      `PAYMENT_PROVIDER=PAYSTACK` and `PAYMENTS_LIVE_ENABLED=true` with live keys.
- [ ] ClamAV: upload the EICAR test file and confirm it is rejected.
- [ ] Email: register a test account and confirm the verification email arrives and its
      link works.
- [ ] SMS: register with a real Nigerian number (one on DND too) and confirm the code
      arrives within a minute; sign in with a texted code.
- [ ] Bank transfer and USSD: in Paystack test mode, pay one order each way and confirm the
      receipt says "Paid by Bank transfer" / "USSD".
- [ ] Installable app: on an Android phone, open the site in Chrome and use "Install app";
      on iPhone, Share → Add to Home Screen.
- [ ] Each university has published a real rate card (or approved shop price bounds).
- [ ] Platform admin and university admins have MFA enrolled.
- [ ] Backups restore successfully (see the runbook).
- [ ] Log shipping and alerting are in place (see the runbook).
- [ ] An independent security review is complete.

## Single host (staging)

`docker compose up --build` runs everything on one machine, including MinIO and ClamAV.
See the comments at the top of [`docker-compose.yml`](../docker-compose.yml). Put a TLS
proxy in front before exposing it.
