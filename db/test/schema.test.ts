import { appendFileSync, cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORDER_TRANSITIONS } from "../../packages/domain/src/index.js";
import { migrateUp, MIGRATIONS_DIR } from "../scripts/migrator.js";
import { createOrder, createQuote, expectDbError, freshDatabase, orderRef, readyDocument, seedWorld, TEST_DATABASE_URL, type World } from "./helpers.js";

let db: pg.Pool;
let alpha: World;
let beta: World;

beforeAll(async () => {
  db = await freshDatabase();
  alpha = await seedWorld(db, "Alpha");
  beta = await seedWorld(db, "Beta");
});
afterAll(async () => {
  await db.end();
});

const insertQuoteSql = `INSERT INTO quotes (university_id, shop_id, student_user_id, document_version_id, document_sha256, rate_card_id, rate_card_version,
   pricing_mode, spec, spec_hash, lines, subtotal_kobo, service_fee_kobo, total_kobo, total_sheets, expires_at)
 VALUES ($1, $2, $3, $4, $5, $6, 1, 'UNIVERSITY_CONTROLLED', '{}', $7, '[]', 100, 0, 100, 1, now() + interval '5 min')`;

describe("migrations", () => {
  it("are idempotent", async () => {
    const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await c.connect();
    expect(await migrateUp(c)).toEqual([]);
    await c.end();
  });

  it("refuse to run when an applied migration was edited", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pf-mig-"));
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    appendFileSync(join(dir, "0001_identity_and_tenancy.sql"), "\n-- tampered\n");
    const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await c.connect();
    await expect(migrateUp(c, dir)).rejects.toThrow("modified after being applied");
    await c.end();
  });
});

describe("order transition table", () => {
  it("matches the domain state machine exactly", async () => {
    const { rows } = await db.query<{ from_status: string; to_status: string }>("SELECT from_status, to_status FROM order_status_transitions");
    const dbSet = rows.map((r) => `${r.from_status}>${r.to_status}`).sort();
    const domainSet = ORDER_TRANSITIONS.map((t) => `${t.from}>${t.to}`).sort();
    expect(dbSet).toEqual(domainSet);
  });

  it("cannot be modified at runtime", async () => {
    await expectDbError(db.query(`INSERT INTO order_status_transitions VALUES ('PAID', 'COLLECTED')`), "append-only");
  });
});

describe("tenant isolation enforced by foreign keys", () => {
  it("rejects a shop placed on another university's campus", async () => {
    await expectDbError(db.query(`INSERT INTO shops (university_id, campus_id, name) VALUES ($1, $2, 'Rogue')`, [alpha.universityId, beta.campusId]), "foreign key");
  });

  it("rejects a quote for a student of another university", async () => {
    await expectDbError(
      db.query(insertQuoteSql, [alpha.universityId, alpha.shopId, beta.studentUserId, alpha.documentVersionId, alpha.documentSha256, alpha.rateCardId, "c".repeat(64)]),
      "foreign key",
    );
  });

  it("rejects quoting a document from another university", async () => {
    await expectDbError(
      db.query(insertQuoteSql, [alpha.universityId, alpha.shopId, alpha.studentUserId, beta.documentVersionId, beta.documentSha256, alpha.rateCardId, "c".repeat(64)]),
      "foreign key",
    );
  });

  it("rejects a quote whose document hash does not match the version", async () => {
    await expectDbError(
      db.query(insertQuoteSql, [alpha.universityId, alpha.shopId, alpha.studentUserId, alpha.documentVersionId, "f".repeat(64), alpha.rateCardId, "c".repeat(64)]),
      "foreign key",
    );
  });

  it("rejects an order whose pickup location belongs to another shop", async () => {
    const q = await createQuote(db, alpha);
    await expectDbError(
      db.query(
        `INSERT INTO orders (reference, university_id, shop_id, student_user_id, pickup_location_id, quote_id, document_version_id, spec_hash, total_kobo, payment_due_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + interval '30 min')`,
        [orderRef(), alpha.universityId, alpha.shopId, alpha.studentUserId, beta.pickupLocationId, q.quoteId, alpha.documentVersionId, q.specHash, q.totalKobo],
      ),
      "foreign key",
    );
  });

  it("rejects staff membership pointing at a shop in another university", async () => {
    await expectDbError(
      db.query(`INSERT INTO shop_memberships (user_id, shop_id, university_id, role) VALUES ($1, $2, $3, 'OPERATOR')`, [alpha.operatorUserId, beta.shopId, alpha.universityId]),
      "foreign key",
    );
  });

  it("rejects unknown shop permissions", async () => {
    await expectDbError(
      db.query(`INSERT INTO shop_memberships (user_id, shop_id, university_id, role, permissions) VALUES ($1, $2, $3, 'OPERATOR', ARRAY['orders.everything'])`, [
        alpha.studentUserId,
        alpha.shopId,
        alpha.universityId,
      ]),
      "check constraint",
    );
  });

  it("allows only one active owner per shop", async () => {
    await expectDbError(
      db.query(`INSERT INTO shop_memberships (user_id, shop_id, university_id, role) VALUES ($1, $2, $3, 'OWNER')`, [alpha.adminUserId, alpha.shopId, alpha.universityId]),
      "shop_one_active_owner",
    );
  });
});

describe("shops", () => {
  it("cannot accept orders unless approved", async () => {
    await expectDbError(
      db.query(`INSERT INTO shops (university_id, campus_id, name, accepting_orders) VALUES ($1, $2, 'Unapproved', true)`, [alpha.universityId, alpha.campusId]),
      "check constraint",
    );
  });
});

describe("rate cards", () => {
  it("published cards cannot have prices edited", async () => {
    await expectDbError(db.query(`UPDATE rate_card_sheet_prices SET price_per_sheet_kobo = 1 WHERE rate_card_id = $1`, [alpha.rateCardId]), "immutable");
    await expectDbError(
      db.query(`INSERT INTO rate_card_finishing (rate_card_id, code, name, unit, price_kobo) VALUES ($1, 'BIND', 'Bind', 'PER_COPY', 1)`, [alpha.rateCardId]),
      "immutable",
    );
    await expectDbError(db.query(`UPDATE rate_cards SET minimum_charge_kobo = 99 WHERE id = $1`, [alpha.rateCardId]), "immutable");
    await expectDbError(db.query(`DELETE FROM rate_cards WHERE id = $1`, [alpha.rateCardId]), "cannot be deleted");
  });

  it("enforces unique versions per scope", async () => {
    await expectDbError(
      db.query(`INSERT INTO rate_cards (university_id, version, effective_from, created_by) VALUES ($1, 1, now(), $2)`, [alpha.universityId, alpha.adminUserId]),
      "rate_card_campus_version_uq",
    );
  });

  it("allows retiring a card and closing its window, then freezes it", async () => {
    const rc = await db.query<{ id: string }>(
      `INSERT INTO rate_cards (university_id, version, effective_from, created_by, status, published_at, published_by)
       VALUES ($1, 50, now(), $2, 'PUBLISHED', now(), $2) RETURNING id`,
      [alpha.universityId, alpha.adminUserId],
    );
    const id = rc.rows[0]!.id;
    await db.query(`UPDATE rate_cards SET effective_to = now() + interval '1 day' WHERE id = $1`, [id]);
    await expectDbError(db.query(`UPDATE rate_cards SET effective_to = now() + interval '2 day' WHERE id = $1`, [id]), "immutable");
    await db.query(`UPDATE rate_cards SET status = 'RETIRED' WHERE id = $1`, [id]);
    await expectDbError(db.query(`UPDATE rate_cards SET status = 'PUBLISHED' WHERE id = $1`, [id]), "immutable");
  });
});

describe("documents", () => {
  it("processed versions are immutable", async () => {
    await expectDbError(db.query(`UPDATE document_versions SET page_count = 1 WHERE id = $1`, [alpha.documentVersionId]), "immutable");
    await expectDbError(db.query(`UPDATE document_versions SET sha256 = $2 WHERE id = $1`, [alpha.documentVersionId, "0".repeat(64)]), "immutable");
  });

  it("cannot be READY without a clean scan", async () => {
    const { documentVersionId } = await readyDocument(db, alpha.studentUserId, alpha.universityId);
    await expectDbError(
      db.query(
        `INSERT INTO document_versions (asset_id, university_id, version_number, storage_key, original_filename, declared_mime, byte_size, sha256, scan_status, processing_status, page_count, print_storage_key, print_sha256)
         SELECT asset_id, university_id, 2, 'docs/' || asset_id || '/' || gen_random_uuid(), 'x.pdf', 'application/pdf', 10, $2, 'PENDING', 'READY', 1,
                'print/' || asset_id || '/' || gen_random_uuid() || '.pdf', $2
           FROM document_versions WHERE id = $1`,
        [documentVersionId, "d".repeat(64)],
      ),
      "check constraint",
    );
  });

  it("rejects storage keys that could traverse paths", async () => {
    await expectDbError(
      db.query(
        `INSERT INTO document_versions (asset_id, university_id, version_number, storage_key, original_filename, declared_mime, byte_size, sha256)
         SELECT asset_id, university_id, 9, 'docs/../../etc/passwd', 'x.pdf', 'application/pdf', 10, $2 FROM document_versions WHERE id = $1`,
        [alpha.documentVersionId, "e".repeat(64)],
      ),
      "check constraint",
    );
  });
});

describe("orders", () => {
  it("must charge exactly the quoted total", async () => {
    const q = await createQuote(db, alpha);
    await expectDbError(
      db.query(
        `INSERT INTO orders (reference, university_id, shop_id, student_user_id, pickup_location_id, quote_id, document_version_id, spec_hash, total_kobo, payment_due_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + interval '30 min')`,
        [orderRef(), alpha.universityId, alpha.shopId, alpha.studentUserId, alpha.pickupLocationId, q.quoteId, alpha.documentVersionId, q.specHash, q.totalKobo - 1],
      ),
      "foreign key",
    );
  });

  it("cannot be created from an expired quote", async () => {
    // Issued 1s ago, expired 0.5s ago.
    await expectDbError(createOrder(db, alpha, { expiresInSeconds: -0.5 }), "has expired");
  });

  it("allow at most one order per quote", async () => {
    const { quoteId } = await createOrder(db, alpha);
    const q = await db.query<{ total_kobo: string; spec_hash: string }>(`SELECT total_kobo, spec_hash FROM quotes WHERE id = $1`, [quoteId]);
    await expectDbError(
      db.query(
        `INSERT INTO orders (reference, university_id, shop_id, student_user_id, pickup_location_id, quote_id, document_version_id, spec_hash, total_kobo, payment_due_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + interval '30 min')`,
        [orderRef(), alpha.universityId, alpha.shopId, alpha.studentUserId, alpha.pickupLocationId, quoteId, alpha.documentVersionId, q.rows[0]!.spec_hash, q.rows[0]!.total_kobo],
      ),
      "orders_quote_id_key",
    );
  });

  it("freeze their terms after creation", async () => {
    const { orderId } = await createOrder(db, alpha);
    await expectDbError(db.query(`UPDATE orders SET total_kobo = 1 WHERE id = $1`, [orderId]), "frozen");
    await expectDbError(db.query(`UPDATE orders SET document_version_id = gen_random_uuid() WHERE id = $1`, [orderId]), "frozen");
    await expectDbError(db.query(`UPDATE orders SET reprint_of_order_id = gen_random_uuid() WHERE id = $1`, [orderId]), /frozen|foreign key/);
  });

  it("reject illegal status jumps at the database level", async () => {
    const { orderId } = await createOrder(db, alpha);
    await expectDbError(db.query(`UPDATE orders SET status = 'COLLECTED' WHERE id = $1`, [orderId]), "illegal order transition");
    await expectDbError(db.query(`UPDATE orders SET status = 'READY_FOR_PICKUP' WHERE id = $1`, [orderId]), "illegal order transition");
  });

  it("cannot be deleted", async () => {
    const { orderId } = await createOrder(db, alpha);
    await expectDbError(db.query(`DELETE FROM orders WHERE id = $1`, [orderId]), "append-only");
  });

  it("cannot be placed with a suspended shop", async () => {
    await db.query(`UPDATE shops SET accepting_orders = false, status = 'SUSPENDED' WHERE id = $1`, [beta.shopId]);
    await expectDbError(createOrder(db, beta), "not accepting orders");
    await db.query(`UPDATE shops SET status = 'APPROVED', accepting_orders = true WHERE id = $1`, [beta.shopId]);
  });
});

describe("audit log", () => {
  it("is append-only", async () => {
    await db.query(`INSERT INTO audit_log (actor_kind, action, entity_type, entity_id) VALUES ('SYSTEM', 'test.event', 'test', '1')`);
    await expectDbError(db.query(`UPDATE audit_log SET action = 'tampered'`), "append-only");
    await expectDbError(db.query(`DELETE FROM audit_log`), "append-only");
    await expectDbError(db.query(`TRUNCATE audit_log`), "append-only");
  });
});
