import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";

export const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? fileURLToPath(new URL("../migrations/", import.meta.url));
const LOCK_KEY = 0x5052_4e54; // "PRNT"

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  return Promise.all(
    files.map(async (name) => {
      const sql = await readFile(join(dir, name), "utf8");
      return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
    }),
  );
}

/**
 * Applies pending migrations, each in its own transaction, under an advisory lock
 * so two deploys cannot migrate concurrently. Refuses to run if an already-applied
 * migration file has been edited (checksum drift).
 */
export async function migrateUp(client: Client, dir = MIGRATIONS_DIR): Promise<string[]> {
  await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = new Map(
      (await client.query<{ name: string; checksum: string }>("SELECT name, checksum FROM schema_migrations")).rows.map((r) => [r.name, r.checksum]),
    );
    const migrations = await loadMigrations(dir);
    for (const m of migrations) {
      const prior = applied.get(m.name);
      if (prior && prior !== m.checksum) {
        throw new Error(`migration ${m.name} was modified after being applied; add a new migration instead`);
      }
    }
    const ran: string[] = [];
    for (const m of migrations) {
      if (applied.has(m.name)) continue;
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [m.name, m.checksum]);
        await client.query("COMMIT");
        ran.push(m.name);
      } catch (e) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${m.name} failed: ${(e as Error).message}`, { cause: e });
      }
    }
    return ran;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
  }
}

export async function migrationStatus(client: Client): Promise<Array<{ name: string; applied: boolean }>> {
  const exists = await client.query("SELECT to_regclass('schema_migrations') AS t");
  const applied = new Set<string>();
  if (exists.rows[0]?.t) {
    for (const r of (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows) applied.add(r.name);
  }
  return (await loadMigrations()).map((m) => ({ name: m.name, applied: applied.has(m.name) }));
}
