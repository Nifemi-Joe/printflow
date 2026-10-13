import type { Pool, PoolClient } from "pg";

/**
 * Runs fn inside a transaction. Uses READ COMMITTED plus explicit row locks
 * (SELECT ... FOR UPDATE) at every decision point, which is what makes the
 * state transitions in this package concurrency-safe.
 */
export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export type Queryable = Pick<PoolClient, "query">;
