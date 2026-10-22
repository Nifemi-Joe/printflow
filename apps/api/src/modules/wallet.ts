import { randomUUID } from "node:crypto";
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import type { Pool } from "pg";
import { grantPromo, naira, revokePromo, walletBalance, walletStatement, withTransaction } from "../../../../packages/data/src/index.js";
import { checkoutMode, type AppConfig } from "../config.js";
import { Access, audit, type UniversityStaffContext } from "../http/access.js";
import type { PfRequest } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { RateLimiter } from "../http/rate-limit.js";
import { Schemas } from "../http/schemas.js";
import { parse, uuid } from "../http/validate.js";
import { devConsole } from "../infra/dev-console.js";
import type { PaymentProvider } from "../infra/payment-provider.js";
import { CONFIG, PAYMENT_PROVIDER, PG_POOL } from "../infra/tokens.js";
import { idempotent } from "./student-orders.js";

/**
 * The student wallet: a spend-only balance for printing.
 * Money goes in by top-up (card, transfer, USSD through the payment provider), by
 * refunds and by university print credit; it goes out only to pay for orders.
 */
@Controller("v1/me/wallet")
export class WalletController {
    constructor(
        @Inject(PG_POOL) private readonly pool: Pool,
        @Inject(CONFIG) private readonly cfg: AppConfig,
        @Inject(Access) private readonly access: Access,
        @Inject(RateLimiter) private readonly limiter: RateLimiter,
        @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider | null,
    ) {}

    private enabled() {
        if (!this.cfg.WALLET_ENABLED) throw Errors.notFound("route");
    }

    @Get()
    async get(@Req() req: PfRequest) {
        this.enabled();
        const st = await this.access.student(req);
        const [balance, entries, pending] = await Promise.all([
            walletBalance(this.pool, st.auth.userId),
            walletStatement(this.pool, st.auth.userId, { limit: 20 }),
            this.pool.query(
                `SELECT provider_reference AS reference, amount_kobo::int AS "amountKobo", status, created_at AS "createdAt" FROM wallet_topups
          WHERE user_id = $1 AND status = 'INITIATED' AND created_at > now() - interval '2 days' ORDER BY created_at DESC LIMIT 5`,
                [st.auth.userId],
            ),
        ]);
        const mode = checkoutMode(this.cfg);
        return {
            ...balance,
            display: { total: naira(balance.totalKobo), cash: naira(balance.cashKobo), promo: naira(balance.promoKobo) },
            limits: {
                maxBalanceKobo: this.cfg.WALLET_MAX_BALANCE_KOBO,
                topupMinKobo: this.cfg.WALLET_TOPUP_MIN_KOBO,
                topupMaxKobo: Math.min(this.cfg.WALLET_TOPUP_MAX_KOBO, Math.max(0, this.cfg.WALLET_MAX_BALANCE_KOBO - balance.totalKobo)),
                lowBalanceKobo: this.cfg.WALLET_LOW_BALANCE_KOBO,
            },
            topUp: { available: mode !== "DISABLED" && Boolean(this.provider), mode, methods: this.cfg.PAYMENT_METHODS },
            pendingTopups: pending.rows,
            entries,
            terms: "Wallet money can only be spent on printing on PrintFlow. It cannot be withdrawn or transferred. Print credit from your university is used first.",
        };
    }

    @Get("entries")
    async entries(@Req() req: PfRequest, @Query() query: unknown) {
        this.enabled();
        const st = await this.access.student(req);
        const { limit, before } = parse(Schemas.WalletStatementQuery, query);
        const items = await walletStatement(this.pool, st.auth.userId, { limit, ...(before ? { beforeId: before } : {}) });
        return { items, nextBefore: items.length === limit ? items[items.length - 1]!.id : null };
    }

    @Post("topups")
    @HttpCode(201)
    async topup(@Req() req: PfRequest, @Body() body: unknown) {
        this.enabled();
        const st = await this.access.student(req);
        const { amountKobo, method } = parse(Schemas.WalletTopup, body);
        const mode = checkoutMode(this.cfg);
        if (mode === "DISABLED" || !this.provider) {
            throw Errors.unavailable("top-ups are not available: payments have not been configured for this installation", "CHECKOUT_DISABLED");
        }
        if (method && !this.cfg.PAYMENT_METHODS.includes(method)) throw Errors.rule("this payment method is not offered; choose another", "METHOD_UNAVAILABLE");
        if (amountKobo < this.cfg.WALLET_TOPUP_MIN_KOBO || amountKobo > this.cfg.WALLET_TOPUP_MAX_KOBO) {
            throw Errors.rule(`top up between ${naira(this.cfg.WALLET_TOPUP_MIN_KOBO)} and ${naira(this.cfg.WALLET_TOPUP_MAX_KOBO)}`, "TOPUP_AMOUNT");
        }
        if (amountKobo % 100 !== 0) throw Errors.rule("top up in whole naira", "TOPUP_AMOUNT");
        await this.limiter.hit(`topup:${st.auth.userId}`, 10, 3600);
        const reference = `pft_${randomUUID().replace(/-/g, "")}`;
        await withTransaction(this.pool, async (c) => {
            // Count top-ups still being paid, so the balance cannot overshoot the limit.
            const { rows } = await c.query<{ balance: string; pending: string }>(
                `SELECT w.cash_kobo + w.promo_kobo AS balance,
                COALESCE((SELECT sum(amount_kobo) FROM wallet_topups t WHERE t.user_id = w.user_id AND t.status = 'INITIATED' AND t.created_at > now() - interval '1 day'), 0) AS pending
           FROM wallets w WHERE w.user_id = $1 FOR UPDATE`,
                [st.auth.userId],
            );
            if (!rows[0]) throw Errors.forbidden("wallets are for student accounts");
            const room = this.cfg.WALLET_MAX_BALANCE_KOBO - Number(rows[0].balance) - Number(rows[0].pending);
            if (amountKobo > room) {
                throw Errors.rule(
                    room > 0 ? `your wallet can hold ${naira(this.cfg.WALLET_MAX_BALANCE_KOBO)}; you can add up to ${naira(room)} now` : `your wallet is at its ${naira(this.cfg.WALLET_MAX_BALANCE_KOBO)} limit`,
                    "WALLET_LIMIT",
                );
            }
            await c.query(
                `INSERT INTO wallet_topups (user_id, university_id, provider, provider_reference, amount_kobo, requested_channel) VALUES ($1, $2, $3, $4, $5, $6)`,
                [st.auth.userId, st.universityId, this.provider!.name, reference, amountKobo, method ?? null],
            );
            await audit(c, { universityId: st.universityId, actorUserId: st.auth.userId, actorKind: "STUDENT", action: "wallet.topup_started", entityType: "wallet", entityId: st.auth.userId, requestId: req.id, details: { reference, amountKobo, method: method ?? "ANY" } });
        });
        const channels = method ? [method] : this.cfg.PAYMENT_METHODS;
        const init = await this.provider.initialize({
            reference,
            amountKobo,
            email: st.auth.email,
            callbackUrl: `${this.cfg.PUBLIC_WEB_URL}/student/wallet?topup=${reference}`,
            channels,
        });
        if (this.cfg.devConsole) {
            devConsole(`wallet top-up link (${mode === "TEST" ? "simulated payment" : "Paystack"})`, [
                { label: "Amount", value: naira(amountKobo) },
                { label: "Method", value: method ?? channels.join(", ") },
                { label: "Reference", value: reference },
                { label: "Link", value: init.checkoutUrl },
            ]);
        }
        return { reference, checkoutUrl: init.checkoutUrl, mode, amountKobo, methods: channels };
    }

    @Get("topups/:reference")
    async topupStatus(@Req() req: PfRequest, @Param("reference") reference: string) {
        this.enabled();
        const st = await this.access.student(req);
        if (!/^pft_[a-f0-9]{32}$/.test(reference)) throw Errors.notFound("top-up");
        const { rows } = await this.pool.query(
            `SELECT provider_reference AS reference, amount_kobo::int AS "amountKobo", status, channel AS "paidWith", created_at AS "createdAt", confirmed_at AS "confirmedAt"
         FROM wallet_topups WHERE provider_reference = $1 AND user_id = $2`,
            [reference, st.auth.userId],
        );
        if (!rows[0]) throw Errors.notFound("top-up");
        return rows[0];
    }
}

/** University staff: print credit for students (welcome credit is in university settings). */
@Controller("v1/admin/universities/:universityId/wallet")
export class UniversityWalletController {
    constructor(
        @Inject(PG_POOL) private readonly pool: Pool,
        @Inject(CONFIG) private readonly cfg: AppConfig,
        @Inject(Access) private readonly access: Access,
    ) {}

    private ctx(req: PfRequest, raw: string, roles: UniversityStaffContext["role"][] = ["UNIVERSITY_ADMIN", "UNIVERSITY_FINANCE"]) {
        if (!this.cfg.WALLET_ENABLED) throw Errors.notFound("route");
        return this.access.university(req, parse(uuid, raw), roles);
    }

    private async findStudent(universityId: string, who: { email?: string | undefined; matricNumber?: string | undefined }) {
        const { rows } = await this.pool.query<{ user_id: string; full_name: string; email: string }>(
            `SELECT sp.user_id, u.full_name, u.email FROM student_profiles sp JOIN users u ON u.id = sp.user_id
        WHERE sp.university_id = $1 AND u.status = 'ACTIVE' AND (($2::text IS NOT NULL AND u.email = $2) OR ($3::text IS NOT NULL AND sp.matric_number = $3))`,
            [universityId, who.email ?? null, who.matricNumber ?? null],
        );
        if (!rows[0]) throw Errors.notFound("student at this university");
        return rows[0];
    }

    @Get("credit")
    async list(@Req() req: PfRequest, @Param("universityId") uid: string) {
        const u = await this.ctx(req, uid, ["UNIVERSITY_ADMIN", "UNIVERSITY_FINANCE", "UNIVERSITY_SUPPORT"]);
        const [items, totals] = await Promise.all([
            this.pool.query(
                `SELECT e.id::int, e.kind, e.promo_kobo::int AS "amountKobo", e.note, e.created_at AS "createdAt",
                s.full_name AS "studentName", s.email AS "studentEmail", g.full_name AS "byName"
           FROM wallet_entries e JOIN users s ON s.id = e.user_id LEFT JOIN users g ON g.id = e.created_by
          WHERE e.university_id = $1 AND e.kind IN ('PROMO_GRANT', 'PROMO_REVOKE', 'WELCOME_CREDIT') ORDER BY e.id DESC LIMIT 100`,
                [u.universityId],
            ),
            this.pool.query<{ granted: string; outstanding: string }>(
                `SELECT COALESCE((SELECT sum(promo_kobo) FROM wallet_entries WHERE university_id = $1 AND kind IN ('PROMO_GRANT', 'WELCOME_CREDIT', 'PROMO_REVOKE')), 0) AS granted,
                COALESCE((SELECT sum(promo_kobo) FROM wallets WHERE university_id = $1), 0) AS outstanding`,
                [u.universityId],
            ),
        ]);
        return {
            items: items.rows,
            grantedNetKobo: Number(totals.rows[0]!.granted),
            unspentKobo: Number(totals.rows[0]!.outstanding),
            maxGrantKobo: this.cfg.PROMO_GRANT_MAX_KOBO,
        };
    }

    @Post("credit")
    @HttpCode(201)
    async grant(@Req() req: PfRequest, @Param("universityId") uid: string, @Body() body: unknown) {
        const u = await this.ctx(req, uid);
        const input = parse(Schemas.PromoCredit, body);
        if (input.amountKobo > this.cfg.PROMO_GRANT_MAX_KOBO) throw Errors.rule(`a single grant can be at most ${naira(this.cfg.PROMO_GRANT_MAX_KOBO)}`, "GRANT_TOO_LARGE");
        const student = await this.findStudent(u.universityId, input);
        const key = req.header("idempotency-key");
        return idempotent(this.pool, u.auth.userId, key, body, async (c) => {
            await grantPromo(c, { userId: student.user_id, universityId: u.universityId, amountKobo: input.amountKobo, note: input.note, grantedBy: u.auth.userId, idempotencyKey: `promo:${u.auth.userId}:${key}` });
            await audit(c, { universityId: u.universityId, actorUserId: u.auth.userId, actorKind: "UNIVERSITY_ADMIN", action: "wallet.credit_granted", entityType: "user", entityId: student.user_id, requestId: req.id, ip: req.ip, details: { amountKobo: input.amountKobo, note: input.note } });
            const b = await c.query<{ promo_kobo: string }>(`SELECT promo_kobo FROM wallets WHERE user_id = $1`, [student.user_id]);
            return { student: { name: student.full_name, email: student.email }, amountKobo: input.amountKobo, studentCreditKobo: Number(b.rows[0]!.promo_kobo) };
        });
    }

    @Post("credit/revoke")
    @HttpCode(200)
    async revoke(@Req() req: PfRequest, @Param("universityId") uid: string, @Body() body: unknown) {
        const u = await this.ctx(req, uid);
        const input = parse(Schemas.PromoCredit, body);
        const student = await this.findStudent(u.universityId, input);
        const key = req.header("idempotency-key");
        return idempotent(this.pool, u.auth.userId, key, body, async (c) => {
            await revokePromo(c, { userId: student.user_id, universityId: u.universityId, amountKobo: input.amountKobo, note: input.note, revokedBy: u.auth.userId, idempotencyKey: `promo-revoke:${u.auth.userId}:${key}` });
            await audit(c, { universityId: u.universityId, actorUserId: u.auth.userId, actorKind: "UNIVERSITY_ADMIN", action: "wallet.credit_revoked", entityType: "user", entityId: student.user_id, requestId: req.id, ip: req.ip, details: { amountKobo: input.amountKobo, note: input.note } });
            const b = await c.query<{ promo_kobo: string }>(`SELECT promo_kobo FROM wallets WHERE user_id = $1`, [student.user_id]);
            return { student: { name: student.full_name, email: student.email }, amountKobo: input.amountKobo, studentCreditKobo: Number(b.rows[0]!.promo_kobo) };
        });
    }
}
