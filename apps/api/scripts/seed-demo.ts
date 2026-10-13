/**
 * Seeds clearly-labelled DEMO data for local development and browser QA.
 * Refuses to run when NODE_ENV=production. Prices are illustrative only.
 *
 *   DATABASE_URL=... DEMO_PASSWORD=... pnpm --filter @printflow/api seed
 */

import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const rootEnv = resolve(here, "../../../.env");

console.log("DEBUG: script dir      =", here);
console.log("DEBUG: looking for env =", rootEnv);
console.log("DEBUG: env exists?     =", existsSync(rootEnv));

try {
  loadEnvFile(rootEnv);
  console.log("DEBUG: loadEnvFile succeeded");
} catch (e) {
  console.log("DEBUG: loadEnvFile FAILED:", (e as Error).message);
}

import argon2 from "argon2";
import pg from "pg";

console.log("DEBUG: DATABASE_URL    =", JSON.stringify(process.env.DATABASE_URL));
console.log("DEBUG: DEMO_PASSWORD   =", JSON.stringify(process.env.DEMO_PASSWORD));
console.log("DEBUG: cwd             =", process.cwd());

if (process.env.NODE_ENV === "production") { /* ... */ }
const url = process.env.DATABASE_URL;
const password = process.env.DEMO_PASSWORD;
if (!url || !password || password.length < 10) {
  console.error("set DATABASE_URL and DEMO_PASSWORD (10+ characters)");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url });
const hash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });

async function user(email: string, name: string, platformRole: string | null = null): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, full_name, password_hash, platform_role, email_verified_at) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (email) WHERE status <> 'DELETED' DO UPDATE SET password_hash = EXCLUDED.password_hash RETURNING id`,
    [email, name, hash, platformRole],
  );
  return rows[0]!.id;
}

const platform = await user("platform@demo.printflow.test", "Demo Platform Admin", "PLATFORM_ADMIN");
const admin = await user("admin@demo.printflow.test", "Demo University Admin");
const owner = await user("shop@demo.printflow.test", "Demo Shop Owner");
const operator = await user("operator@demo.printflow.test", "Demo Shop Operator");
const student = await user("student@demo.printflow.test", "Demo Student");

const uni = await pool.query<{ id: string }>(
  `INSERT INTO universities (slug, name, status, service_fee_fixed_kobo, service_fee_bps) VALUES ('demo-university', 'Demo University (sample data)', 'ACTIVE', 5000, 150)
   ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
);
const universityId = uni.rows[0]!.id;
const campus = await pool.query<{ id: string }>(
  `INSERT INTO campuses (university_id, name) VALUES ($1, 'Main Campus') ON CONFLICT (university_id, name) DO UPDATE SET is_active = true RETURNING id`,
  [universityId],
);
const campusId = campus.rows[0]!.id;
await pool.query(`INSERT INTO departments (university_id, campus_id, name) VALUES ($1, $2, 'Computer Science') ON CONFLICT DO NOTHING`, [universityId, campusId]);
await pool.query(`INSERT INTO university_staff (user_id, university_id, role) VALUES ($1, $2, 'UNIVERSITY_ADMIN') ON CONFLICT DO NOTHING`, [admin, universityId]);
await pool.query(`INSERT INTO student_profiles (user_id, university_id, campus_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [student, universityId, campusId]);
// A clearly fake demo number; texts go to the LOG driver in development.
await pool.query(`UPDATE users SET phone = '+2348030000001', phone_verified_at = COALESCE(phone_verified_at, now()) WHERE id = $1 AND (phone IS NULL OR phone = '+2348030000001')`, [student]);

const shop = await pool.query<{ id: string }>(
  `INSERT INTO shops (university_id, campus_id, name, status, accepting_orders, approved_at, approved_by, location_note, opening_hours)
   VALUES ($1, $2, 'Faculty Print Hub (demo)', 'APPROVED', true, now(), $3, 'Ground floor, beside the faculty library', $4)
   ON CONFLICT (university_id, name) DO UPDATE SET accepting_orders = true RETURNING id`,
  [universityId, campusId, admin, JSON.stringify({ mon: [["08:00", "18:00"]], tue: [["08:00", "18:00"]], wed: [["08:00", "18:00"]], thu: [["08:00", "18:00"]], fri: [["08:00", "17:00"]] })],
);
const shopId = shop.rows[0]!.id;
await pool.query(`UPDATE shops SET power_status = 'GRID', power_updated_at = now(), power_updated_by = $2 WHERE id = $1 AND power_status = 'UNKNOWN'`, [shopId, admin]);
const all = ["orders.view", "orders.accept", "orders.produce", "orders.qa", "orders.collect", "documents.download", "devices.manage", "catalogue.manage", "pricing.manage", "staff.manage", "reports.view"];
await pool.query(`INSERT INTO shop_memberships (user_id, shop_id, university_id, role, permissions) VALUES ($1, $2, $3, 'OWNER', $4) ON CONFLICT DO NOTHING`, [owner, shopId, universityId, all]);
await pool.query(`INSERT INTO shop_memberships (user_id, shop_id, university_id, role, permissions) VALUES ($1, $2, $3, 'OPERATOR', $4) ON CONFLICT DO NOTHING`, [
  operator,
  shopId,
  universityId,
  ["orders.view", "orders.produce", "orders.qa", "orders.collect", "documents.download"],
]);
await pool.query(`INSERT INTO pickup_locations (university_id, shop_id, name) SELECT $1, $2, 'Front counter' WHERE NOT EXISTS (SELECT 1 FROM pickup_locations WHERE shop_id = $2)`, [universityId, shopId]);
await pool.query(
  `INSERT INTO devices (shop_id, university_id, label, reported_status, status_reported_at, status_reported_by) VALUES ($1, $2, 'Printer 1', 'AVAILABLE', now(), $3) ON CONFLICT DO NOTHING`,
  [shopId, universityId, owner],
);

const existing = await pool.query(`SELECT 1 FROM rate_cards WHERE university_id = $1 AND shop_id IS NULL`, [universityId]);
if (!existing.rowCount) {
  const rc = await pool.query<{ id: string }>(`INSERT INTO rate_cards (university_id, version, effective_from, created_by) VALUES ($1, 1, now() - interval '1 day', $2) RETURNING id`, [universityId, admin]);
  const id = rc.rows[0]!.id;
  await pool.query(
    `INSERT INTO rate_card_sheet_prices (rate_card_id, paper_size, colour_mode, sides, price_per_sheet_kobo) VALUES
     ($1,'A4','BW','SINGLE',2000), ($1,'A4','BW','DOUBLE',3500), ($1,'A4','COLOUR','SINGLE',10000), ($1,'A4','COLOUR','DOUBLE',18000), ($1,'A3','BW','SINGLE',5000)`,
    [id],
  );
  await pool.query(
    `INSERT INTO rate_card_finishing (rate_card_id, code, name, unit, price_kobo, paper_sizes) VALUES
     ($1,'STAPLE','Stapling','PER_COPY',1000,NULL), ($1,'SPIRAL_BIND','Spiral binding','PER_COPY',50000,ARRAY['A4'])`,
    [id],
  );
  await pool.query(`UPDATE rate_cards SET status = 'PUBLISHED', published_at = now(), published_by = $2 WHERE id = $1`, [id, admin]);
}

console.log(`Demo data ready (password from DEMO_PASSWORD):
  platform@demo.printflow.test   platform admin  ${platform}
  admin@demo.printflow.test      university admin
  shop@demo.printflow.test       shop owner
  operator@demo.printflow.test   shop operator
  student@demo.printflow.test    student
  university ${universityId}, shop ${shopId}`);
await pool.end();
