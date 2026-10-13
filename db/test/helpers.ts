import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { migrateUp } from "../scripts/migrator.js";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://printflow:printflow_dev@localhost:5432/printflow_test";

if (!/_test$/.test(new URL(TEST_DATABASE_URL).pathname)) {
  throw new Error("refusing to run destructive tests against a database whose name does not end in _test");
}

export const PEPPER = "integration-test-pepper-0123456789abcdef";
export const FAKE_HASH = "$argon2id$v=19$m=65536,t=3,p=4$dGVzdHNhbHQ$dGVzdGhhc2g";

/**
 * Recreates the schema of a test database. Pass a name ending in _test to use a
 * separate database (created on demand) so several apps can run side by side.
 */
export async function freshDatabase(dbName?: string): Promise<pg.Pool> {
  let url = TEST_DATABASE_URL;
  if (dbName) {
    if (!/^[a-z0-9_]+_test$/.test(dbName)) throw new Error("test database names must end in _test");
    const base = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await base.connect();
    const exists = await base.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [dbName]);
    if (!exists.rowCount) await base.query(`CREATE DATABASE ${dbName}`);
    await base.end();
    const u = new URL(TEST_DATABASE_URL);
    u.pathname = `/${dbName}`;
    url = u.toString();
  }
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  await migrateUp(admin);
  await admin.end();
  return new pg.Pool({ connectionString: url, max: 10 });
}

/** Expects the promise to fail with a Postgres error whose message contains `fragment`. */
export async function expectDbError(p: Promise<unknown>, fragment: string | RegExp): Promise<void> {
  try {
    await p;
  } catch (e) {
    const msg = (e as Error).message;
    if (typeof fragment === "string" ? msg.includes(fragment) : fragment.test(msg)) return;
    throw new Error(`expected error matching ${String(fragment)}, got: ${msg}`);
  }
  throw new Error(`expected error matching ${String(fragment)}, but the statement succeeded`);
}

export interface World {
  universityId: string;
  campusId: string;
  shopId: string;
  pickupLocationId: string;
  deviceId: string;
  adminUserId: string;
  ownerUserId: string;
  operatorUserId: string;
  studentUserId: string;
  rateCardId: string;
  documentVersionId: string;
  documentSha256: string;
}

let counter = 0;
const uniq = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

async function user(db: pg.Pool, name: string, platformRole: string | null = null): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, full_name, password_hash, platform_role) VALUES ($1, $2, $3, $4) RETURNING id`,
    [`${name.toLowerCase().replace(/\s/g, ".")}.${uniq()}@example.test`, name, FAKE_HASH, platformRole],
  );
  return rows[0]!.id;
}

/** One university with one approved shop, staff, a student, a published rate card and a READY document. */
export async function seedWorld(db: pg.Pool, label = "Alpha"): Promise<World> {
  const slug = `${label.toLowerCase()}-${uniq()}`;
  const uni = await db.query<{ id: string }>(
    `INSERT INTO universities (slug, name, status, service_fee_fixed_kobo, service_fee_bps) VALUES ($1, $2, 'ACTIVE', 5000, 150) RETURNING id`,
    [slug, `${label} University`],
  );
  const universityId = uni.rows[0]!.id;
  const campus = await db.query<{ id: string }>(`INSERT INTO campuses (university_id, name) VALUES ($1, 'Main Campus') RETURNING id`, [universityId]);
  const campusId = campus.rows[0]!.id;

  const adminUserId = await user(db, `${label} Admin`);
  await db.query(`INSERT INTO university_staff (user_id, university_id, role) VALUES ($1, $2, 'UNIVERSITY_ADMIN')`, [adminUserId, universityId]);

  const shop = await db.query<{ id: string }>(
    `INSERT INTO shops (university_id, campus_id, name, status, accepting_orders, approved_at, approved_by)
     VALUES ($1, $2, $3, 'APPROVED', true, now(), $4) RETURNING id`,
    [universityId, campusId, `${label} Print Hub`, adminUserId],
  );
  const shopId = shop.rows[0]!.id;
  const pl = await db.query<{ id: string }>(`INSERT INTO pickup_locations (university_id, shop_id, name) VALUES ($1, $2, 'Front counter') RETURNING id`, [universityId, shopId]);
  const dev = await db.query<{ id: string }>(`INSERT INTO devices (shop_id, university_id, label) VALUES ($1, $2, 'Printer 1') RETURNING id`, [shopId, universityId]);

  const ownerUserId = await user(db, `${label} Owner`);
  const operatorUserId = await user(db, `${label} Operator`);
  await db.query(
    `INSERT INTO shop_memberships (user_id, shop_id, university_id, role, permissions) VALUES
     ($1, $3, $4, 'OWNER', ARRAY['orders.view','orders.accept','orders.produce','orders.qa','orders.collect','documents.download','pricing.manage','staff.manage','reports.view']),
     ($2, $3, $4, 'OPERATOR', ARRAY['orders.view','orders.produce'])`,
    [ownerUserId, operatorUserId, shopId, universityId],
  );

  const studentUserId = await user(db, `${label} Student`);
  await db.query(`INSERT INTO student_profiles (user_id, university_id, campus_id) VALUES ($1, $2, $3)`, [studentUserId, universityId, campusId]);

  const rc = await db.query<{ id: string }>(
    `INSERT INTO rate_cards (university_id, version, effective_from, created_by) VALUES ($1, 1, now() - interval '1 day', $2) RETURNING id`,
    [universityId, adminUserId],
  );
  const rateCardId = rc.rows[0]!.id;
  await db.query(
    `INSERT INTO rate_card_sheet_prices (rate_card_id, paper_size, colour_mode, sides, price_per_sheet_kobo) VALUES
     ($1, 'A4', 'BW', 'SINGLE', 2000), ($1, 'A4', 'BW', 'DOUBLE', 3500)`,
    [rateCardId],
  );
  await db.query(`INSERT INTO rate_card_finishing (rate_card_id, code, name, unit, price_kobo) VALUES ($1, 'STAPLE', 'Stapling', 'PER_COPY', 1000)`, [rateCardId]);
  await db.query(`UPDATE rate_cards SET status = 'PUBLISHED', published_at = now(), published_by = $2 WHERE id = $1`, [rateCardId, adminUserId]);

  const { documentVersionId, documentSha256 } = await readyDocument(db, studentUserId, universityId);

  return {
    universityId,
    campusId,
    shopId,
    pickupLocationId: pl.rows[0]!.id,
    deviceId: dev.rows[0]!.id,
    adminUserId,
    ownerUserId,
    operatorUserId,
    studentUserId,
    rateCardId,
    documentVersionId,
    documentSha256,
  };
}

export async function readyDocument(db: pg.Pool, studentUserId: string, universityId: string): Promise<{ assetId: string; documentVersionId: string; documentSha256: string }> {
  const asset = await db.query<{ id: string }>(`INSERT INTO document_assets (owner_user_id, university_id, title) VALUES ($1, $2, 'Lecture notes') RETURNING id`, [studentUserId, universityId]);
  const assetId = asset.rows[0]!.id;
  const versionId = randomUUID();
  const sha = createHash("sha256").update(versionId).digest("hex");
  await db.query(
    `INSERT INTO document_versions (id, asset_id, university_id, version_number, storage_key, original_filename, declared_mime,
       detected_type, byte_size, sha256, print_storage_key, print_sha256, page_count, scan_status, processing_status)
     VALUES ($1, $2, $3, 1, $4, 'notes.pdf', 'application/pdf', 'PDF', 12345, $5, $6, $5, 10, 'CLEAN', 'READY')`,
    [versionId, assetId, universityId, `docs/${assetId}/${versionId}`, sha, `print/${assetId}/${versionId}.pdf`],
  );
  return { assetId, documentVersionId: versionId, documentSha256: sha };
}

export async function createQuote(db: pg.Pool, w: World, opts: { totalKobo?: number; expiresInSeconds?: number } = {}): Promise<{ quoteId: string; totalKobo: number; specHash: string }> {
  const fee = 5_300;
  const total = opts.totalKobo ?? 20_000 + fee;
  const specHash = createHash("sha256").update(randomUUID()).digest("hex");
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO quotes (university_id, shop_id, student_user_id, document_version_id, document_sha256, rate_card_id, rate_card_version,
       pricing_mode, spec, spec_hash, lines, subtotal_kobo, service_fee_kobo, total_kobo, total_sheets, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, 1, 'UNIVERSITY_CONTROLLED', '{}'::jsonb, $7, '[]'::jsonb, $8, $9, $10, 10,
             now() - interval '1 second', now() + make_interval(secs => $11))
     RETURNING id`,
    [w.universityId, w.shopId, w.studentUserId, w.documentVersionId, w.documentSha256, w.rateCardId, specHash, total - fee, fee, total, opts.expiresInSeconds ?? 1800],
  );
  return { quoteId: rows[0]!.id, totalKobo: total, specHash };
}

export async function createOrder(db: pg.Pool, w: World, opts: { expiresInSeconds?: number } = {}): Promise<{ orderId: string; totalKobo: number; quoteId: string }> {
  const q = await createQuote(db, w, opts);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO orders (reference, university_id, shop_id, student_user_id, pickup_location_id, quote_id, document_version_id,
       spec_hash, total_kobo, payment_due_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + interval '30 minutes') RETURNING id`,
    [orderRef(), w.universityId, w.shopId, w.studentUserId, w.pickupLocationId, q.quoteId, w.documentVersionId, q.specHash, q.totalKobo],
  );
  return { orderId: rows[0]!.id, totalKobo: q.totalKobo, quoteId: q.quoteId };
}

export function orderRef(): string {
  const alphabet = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let s = "";
  for (let i = 0; i < 8; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `PF-${s}`;
}

export async function initiatePayment(db: pg.Pool, orderId: string, amountKobo: number, universityId: string): Promise<string> {
  const ref = `pf_${randomUUID()}`;
  await db.query(`INSERT INTO payments (order_id, university_id, provider, provider_reference, amount_kobo) VALUES ($1, $2, 'TEST', $3, $4)`, [orderId, universityId, ref, amountKobo]);
  return ref;
}
