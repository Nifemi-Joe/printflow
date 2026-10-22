import { mkdtempSync } from "node:fs";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import argon2 from "argon2";
import type pg from "pg";
import pino from "pino";
import request from "supertest";
import { ClamdScanner, DEFAULT_TOOLS } from "../../../packages/documents/src/index.js";
import { startFakeClamd } from "../../../packages/documents/test/fixtures.js";
import { LocalStorage } from "../../../packages/storage/src/index.js";
import { CaptureMailer, CaptureSms, NoneSms, TestPaymentProvider, type SmsSender } from "../../../packages/providers/src/index.js";
import { freshDatabase, TEST_DATABASE_URL } from "../../../db/test/helpers.js";
import type { WorkerDeps } from "../../worker/src/handlers.js";
import { drainOnce } from "../../worker/src/runner.js";
import { createApp } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { base32Decode, hotp, totpStep } from "../src/http/crypto.js";

export const PASSWORD = "Correct-Horse-Battery-9";
const STORAGE_SECRET = "storage-signing-secret-for-tests-0123456789";

export interface Harness {
  app: INestApplication;
  http: ReturnType<typeof request>;
  cfg: AppConfig;
  pool: pg.Pool;
  mailer: CaptureMailer;
  sms: CaptureSms;
  storage: LocalStorage;
  worker: WorkerDeps;
  clamd: Server;
  drain: () => Promise<number>;
  close: () => Promise<void>;
}

export async function startHarness(env: Record<string, string> = {}, dbName?: string): Promise<Harness> {
  const pool = await freshDatabase(dbName);
  const dir = mkdtempSync(join(tmpdir(), "pf-api-store-"));
  const cfg = loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL: dbName ? TEST_DATABASE_URL.replace(/\/[^/]+$/, `/${dbName}`) : TEST_DATABASE_URL,
    SESSION_SECRET: "session-secret-for-tests-0123456789abcdef",
    PICKUP_CODE_PEPPER: "pickup-pepper-for-tests-0123456789abcdef",
    MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    REQUIRE_STAFF_MFA: "false",
    REQUIRE_EMAIL_VERIFICATION: "true",
    STORAGE_DRIVER: "LOCAL",
    STORAGE_DIR: dir,
    STORAGE_SIGNING_SECRET: STORAGE_SECRET,
    PUBLIC_API_URL: "http://api.test",
    PUBLIC_WEB_URL: "http://web.test",
    CORS_ORIGINS: "http://web.test",
    PAYMENT_PROVIDER: "TEST",
    EMAIL_DRIVER: "CAPTURE",
    SMS_DRIVER: "CAPTURE",
    // Keep test output clean; the dev console has its own tests.
    DEV_CONSOLE: "false",
    RATE_LIMIT_SCALE: "100",
    ...env,
  });
  const log = pino({ level: process.env.HARNESS_LOG ?? "silent" });
  const mailer = new CaptureMailer();
  const sms = new CaptureSms();
  const smsSender: SmsSender = cfg.SMS_DRIVER === "NONE" ? new NoneSms() : sms;
  const storage = new LocalStorage(dir, STORAGE_SECRET, cfg.PUBLIC_API_URL);
  const payments = cfg.PAYMENT_PROVIDER === "TEST" ? new TestPaymentProvider(cfg.PUBLIC_WEB_URL, cfg.TEST_WEBHOOK_SECRET) : null;
  const app = await createApp(cfg, { pool, log, storage, mailer, sms: smsSender, payments });
  await app.init();
  const fake = await startFakeClamd();
  const worker: WorkerDeps = {
    pool,
    log,
    storage,
    scanner: new ClamdScanner("127.0.0.1", fake.port),
    tools: { ...DEFAULT_TOOLS, timeoutMs: 120_000 },
    mailer,
    sms: smsSender,
    payments,
    webUrl: cfg.PUBLIC_WEB_URL,
  };
  const drain = async () => {
    let total = 0;
    for (;;) {
      const n = await drainOnce(worker, "test-worker", 10);
      total += n;
      if (n === 0) return total;
    }
  };
  return {
    app,
    http: request(app.getHttpServer()),
    cfg,
    pool,
    mailer,
    sms,
    storage,
    worker,
    clamd: fake.server,
    drain,
    close: async () => {
      fake.server.close();
      await app.close();
      await pool.end();
    },
  };
}

/** A signed-in browser-like client: keeps the cookie and sends the CSRF header. */
export class Client {
  csrf = "";
  constructor(
      readonly h: Harness,
      readonly agent: ReturnType<typeof request.agent>,
  ) {}

  static async login(h: Harness, email: string, password = PASSWORD, extra: Record<string, unknown> = {}): Promise<Client> {
    const agent = request.agent(h.app.getHttpServer());
    const res = await agent.post("/v1/auth/login").send({ email, password, ...extra });
    if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
    const c = new Client(h, agent);
    c.csrf = res.body.csrfToken;
    return c;
  }

  get(path: string) {
    return this.agent.get(path);
  }
  post(path: string, body?: unknown, headers: Record<string, string> = {}) {
    return this.agent.post(path).set("X-CSRF-Token", this.csrf).set(headers).send(body as object);
  }
  patch(path: string, body?: unknown) {
    return this.agent.patch(path).set("X-CSRF-Token", this.csrf).send(body as object);
  }
  put(path: string, body?: unknown) {
    return this.agent.put(path).set("X-CSRF-Token", this.csrf).send(body as object);
  }
  delete(path: string) {
    return this.agent.delete(path).set("X-CSRF-Token", this.csrf);
  }
  upload(path: string, bytes: Buffer, filename: string, mime = "application/pdf") {
    return this.agent.post(path).set("X-CSRF-Token", this.csrf).set("Content-Type", mime).set("X-Filename", encodeURIComponent(filename)).send(bytes);
  }
}

let n = 0;
export const uniqueEmail = (label: string) => `${label}.${Date.now().toString(36)}${(n++).toString(36)}@example.test`;

export async function createUser(h: Harness, label: string, opts: { platformRole?: "PLATFORM_ADMIN" | "PLATFORM_SUPPORT"; verified?: boolean } = {}): Promise<{ id: string; email: string }> {
  const email = uniqueEmail(label);
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  const { rows } = await h.pool.query<{ id: string }>(
      `INSERT INTO users (email, full_name, password_hash, platform_role, email_verified_at) VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN now() END) RETURNING id`,
      [email, `${label} Person`, hash, opts.platformRole ?? null, opts.verified ?? true],
  );
  return { id: rows[0]!.id, email };
}

export function totpNow(secretB32: string, offsetSteps = 0): string {
  return hotp(base32Decode(secretB32), totpStep() + offsetSteps);
}

export interface Campus {
  universityId: string;
  campusId: string;
  admin: Client;
  adminUser: { id: string; email: string };
}

/** Platform admin onboards a university over HTTP; returns a signed-in university admin. */
export async function onboardUniversity(h: Harness, platform: Client, slug: string): Promise<Campus> {
  const uni = await platform.post("/v1/platform/universities", { slug, name: `${slug} University` });
  if (uni.status !== 201) throw new Error(JSON.stringify(uni.body));
  const adminUser = await createUser(h, `${slug}-admin`);
  await platform.post(`/v1/platform/universities/${uni.body.id}/admins`, { email: adminUser.email });
  const admin = await Client.login(h, adminUser.email);
  const campus = await admin.post(`/v1/admin/universities/${uni.body.id}/campuses`, { name: "Main Campus" });
  const act = await platform.patch(`/v1/platform/universities/${uni.body.id}`, { status: "ACTIVE", serviceFeeFixedKobo: 5_000, serviceFeeBps: 150 });
  if (act.status !== 200) throw new Error(JSON.stringify(act.body));
  return { universityId: uni.body.id, campusId: campus.body.id, admin, adminUser };
}

export const CAMPUS_CARD = {
  effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
  oddPageDuplexPolicy: "CHARGE_FULL_SHEET",
  minimumChargeKobo: 0,
  sheetPrices: [
    { paperSize: "A4", colourMode: "BW", sides: "SINGLE", pricePerSheetKobo: 2_000 },
    { paperSize: "A4", colourMode: "BW", sides: "DOUBLE", pricePerSheetKobo: 3_500 },
    { paperSize: "A4", colourMode: "COLOUR", sides: "SINGLE", pricePerSheetKobo: 10_000 },
  ],
  finishing: [
    { code: "STAPLE", name: "Stapling", unit: "PER_COPY", priceKobo: 1_000 },
    { code: "SPIRAL_BIND", name: "Spiral binding", unit: "PER_COPY", priceKobo: 50_000, paperSizes: ["A4"] },
  ],
};

export async function publishCampusCard(c: Campus, card: object = CAMPUS_CARD): Promise<string> {
  const d = await c.admin.post(`/v1/admin/universities/${c.universityId}/rate-cards`, card);
  if (d.status !== 201) throw new Error(JSON.stringify(d.body));
  const p = await c.admin.post(`/v1/admin/universities/${c.universityId}/rate-cards/${d.body.id}/publish`);
  if (p.status !== 200) throw new Error(JSON.stringify(p.body));
  return d.body.id;
}

export interface ShopSetup {
  shopId: string;
  owner: Client;
  ownerUser: { id: string; email: string };
  pickupLocationId: string;
  deviceId: string;
}

/** Owner applies, the university approves, the owner opens for business. */
export async function openShop(h: Harness, c: Campus, name: string): Promise<ShopSetup> {
  const ownerUser = await createUser(h, `${name.replace(/\W/g, "").toLowerCase()}-owner`);
  const owner = await Client.login(h, ownerUser.email);
  const applied = await owner.post("/v1/shops", { universityId: c.universityId, campusId: c.campusId, name });
  if (applied.status !== 201) throw new Error(JSON.stringify(applied.body));
  const shopId = applied.body.id;
  const ok = await c.admin.post(`/v1/admin/universities/${c.universityId}/shops/${shopId}/status`, { action: "approve", reason: "Inspected premises" });
  if (ok.status !== 200) throw new Error(JSON.stringify(ok.body));
  const pl = await owner.post(`/v1/shops/${shopId}/pickup-locations`, { name: "Front counter" });
  const dev = await owner.post(`/v1/shops/${shopId}/devices`, { label: "Printer 1" });
  await owner.patch(`/v1/shops/${shopId}/devices/${dev.body.id}`, { reportedStatus: "AVAILABLE" });
  const open = await owner.patch(`/v1/shops/${shopId}`, { acceptingOrders: true });
  if (open.status !== 200) throw new Error(JSON.stringify(open.body));
  return { shopId, owner, ownerUser, pickupLocationId: pl.body.id, deviceId: dev.body.id };
}

/** Registers a student over HTTP and verifies their email using the captured link. */
export async function registerStudent(h: Harness, c: Campus, label: string): Promise<{ client: Client; email: string; userId: string }> {
  const email = uniqueEmail(label);
  const agent = request.agent(h.app.getHttpServer());
  const res = await agent.post("/v1/auth/register").send({ email, password: PASSWORD, fullName: `${label} Student`, universityId: c.universityId, campusId: c.campusId });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  const client = new Client(h, agent);
  client.csrf = res.body.csrfToken;
  const token = /token=([\w-]+)/.exec(h.mailer.last(email)!.text)![1];
  const v = await client.post("/v1/auth/verify-email", { token });
  if (v.status !== 200) throw new Error(JSON.stringify(v.body));
  return { client, email, userId: res.body.user.id };
}
