import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import { PG_POOL } from "../infra/tokens.js";
import { Errors } from "./errors.js";

/**
 * Fixed-window rate limiting backed by PostgreSQL, so limits hold across every
 * API instance. Buckets are namespaced strings such as "login:ip:1.2.3.4".
 */
@Injectable()
export class RateLimiter {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly scale = 1,
  ) {}

  async hit(bucket: string, baseLimit: number, windowSeconds: number): Promise<void> {
    const limit = baseLimit * this.scale;
    const { rows } = await this.pool.query<{ hits: number; window_start: Date }>(
      `INSERT INTO rate_limit_counters (bucket, window_start, hits)
       VALUES ($1, to_timestamp(floor(extract(epoch FROM now()) / $2) * $2), 1)
       ON CONFLICT (bucket, window_start) DO UPDATE SET hits = rate_limit_counters.hits + 1
       RETURNING hits, window_start`,
      [bucket.slice(0, 200), windowSeconds],
    );
    const row = rows[0]!;
    if (row.hits > limit) {
      const retry = Math.max(1, Math.ceil((row.window_start.getTime() + windowSeconds * 1000 - Date.now()) / 1000));
      throw Errors.rateLimited(retry);
    }
  }

  /** Removes windows older than a day. Called opportunistically. */
  async sweep(): Promise<void> {
    await this.pool.query(`DELETE FROM rate_limit_counters WHERE window_start < now() - interval '1 day'`);
  }
}
