import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import type { ShopPermission } from "../../../../packages/domain/src/index.js";
import type { Queryable } from "../../../../packages/data/src/index.js";
import type { AppConfig } from "../config.js";
import { CONFIG, PG_POOL } from "../infra/tokens.js";
import type { AuthContext, PfRequest } from "./context.js";
import { Errors } from "./errors.js";

export interface StudentContext {
  auth: AuthContext;
  universityId: string;
  campusId: string;
}

export interface ShopMembership {
  auth: AuthContext;
  shopId: string;
  universityId: string;
  role: "OWNER" | "MANAGER" | "OPERATOR";
  permissions: ShopPermission[];
}

export interface UniversityStaffContext {
  auth: AuthContext;
  universityId: string;
  role: "UNIVERSITY_ADMIN" | "UNIVERSITY_FINANCE" | "UNIVERSITY_SUPPORT";
}

/**
 * Server-side, tenant-aware authorization. Every check is re-derived from the
 * database on each request; nothing about roles is trusted from the client.
 */
@Injectable()
export class Access {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  user(req: PfRequest): AuthContext {
    if (!req.auth) throw Errors.unauthenticated();
    return req.auth;
  }

  private requireMfa(auth: AuthContext): void {
    if (this.cfg.REQUIRE_STAFF_MFA && !auth.mfaVerified) throw Errors.mfaRequired();
  }

  async student(req: PfRequest): Promise<StudentContext> {
    const auth = this.user(req);
    const { rows } = await this.pool.query<{ university_id: string; campus_id: string }>(
      `SELECT sp.university_id, sp.campus_id FROM student_profiles sp JOIN universities u ON u.id = sp.university_id
        WHERE sp.user_id = $1 AND u.status = 'ACTIVE'`,
      [auth.userId],
    );
    if (!rows[0]) throw Errors.forbidden("a student profile at an active university is required");
    return { auth, universityId: rows[0].university_id, campusId: rows[0].campus_id };
  }

  async shop(req: PfRequest, shopId: string, permission?: ShopPermission, db: Queryable = this.pool): Promise<ShopMembership> {
    const auth = this.user(req);
    const { rows } = await db.query<{ university_id: string; role: ShopMembership["role"]; permissions: ShopPermission[] }>(
      `SELECT m.university_id, m.role, m.permissions FROM shop_memberships m JOIN shops s ON s.id = m.shop_id
        WHERE m.user_id = $1 AND m.shop_id = $2 AND m.revoked_at IS NULL AND s.status <> 'REMOVED'`,
      [auth.userId, shopId],
    );
    const m = rows[0];
    if (!m) throw Errors.forbidden("you are not a member of this shop");
    this.requireMfa(auth);
    if (permission && !m.permissions.includes(permission)) throw Errors.forbidden(`requires shop permission ${permission}`);
    return { auth, shopId, universityId: m.university_id, role: m.role, permissions: m.permissions };
  }

  async university(req: PfRequest, universityId: string, roles: UniversityStaffContext["role"][] = ["UNIVERSITY_ADMIN"]): Promise<UniversityStaffContext> {
    const auth = this.user(req);
    const { rows } = await this.pool.query<{ role: UniversityStaffContext["role"] }>(
      `SELECT role FROM university_staff WHERE user_id = $1 AND university_id = $2 AND revoked_at IS NULL`,
      [auth.userId, universityId],
    );
    const role = rows[0]?.role;
    if (!role || !roles.includes(role)) throw Errors.forbidden("university administrator access is required");
    this.requireMfa(auth);
    return { auth, universityId, role };
  }

  platform(req: PfRequest, roles: Array<"PLATFORM_ADMIN" | "PLATFORM_SUPPORT"> = ["PLATFORM_ADMIN"]): AuthContext {
    const auth = this.user(req);
    if (!auth.platformRole || !roles.includes(auth.platformRole)) throw Errors.forbidden("platform administrator access is required");
    this.requireMfa(auth);
    return auth;
  }
}

export interface AuditEntry {
  universityId?: string | null;
  shopId?: string | null;
  actorUserId: string | null;
  actorKind: "STUDENT" | "SHOP_STAFF" | "UNIVERSITY_ADMIN" | "PLATFORM_ADMIN" | "SYSTEM";
  action: string;
  entityType: string;
  entityId: string;
  requestId?: string;
  ip?: string | undefined;
  details?: Record<string, unknown>;
}

export async function audit(db: Queryable, e: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (university_id, shop_id, actor_user_id, actor_kind, action, entity_type, entity_id, request_id, ip_address, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [e.universityId ?? null, e.shopId ?? null, e.actorUserId, e.actorKind, e.action, e.entityType, e.entityId, e.requestId ?? null, e.ip ?? null, JSON.stringify(e.details ?? {})],
  );
}
