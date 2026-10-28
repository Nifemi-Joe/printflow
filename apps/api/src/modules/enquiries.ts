import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Req } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import type { Logger } from "pino";
import { withTransaction } from "../../../../packages/data/src/index.js";
import { z } from "zod";
import {
    canConvert,
    canMoveEnquiry,
    ENQUIRY_KIND_LABELS,
    ENQUIRY_KINDS,
    ENQUIRY_STATUSES,
    enquiryAge,
    newEnquiryReference,
    slugifyUniversity,
    spamScore,
    SPAM_SUSPECT_AT,
    startingPriority,
    type EnquiryKind,
    type EnquiryPriority,
    type EnquiryStatus,
} from "../../../../packages/domain/src/index.js";
import type { Mailer } from "../../../../packages/providers/src/index.js";
import type { AppConfig } from "../config.js";
import { Access, audit } from "../http/access.js";
import type { PfRequest } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { RateLimiter } from "../http/rate-limit.js";
import { Schemas } from "../http/schemas.js";
import { decodeCursor, encodeCursor, Pagination, parse, uuid } from "../http/validate.js";
import { devConsole } from "../infra/dev-console.js";
import { CONFIG, LOGGER, MAILER, PG_POOL } from "../infra/tokens.js";

interface EnquiryRow {
    id: string;
    reference: string;
    kind: EnquiryKind;
    status: EnquiryStatus;
    priority: EnquiryPriority;
    name: string;
    email: string;
    organisation: string | null;
    createdAt: Date;
    firstResponseAt: Date | null;
}

/** Adds the waiting time and whether it has gone past its target. */
function withAge<T extends EnquiryRow>(e: T) {
    const age = enquiryAge({ createdAt: e.createdAt, firstResponseAt: e.firstResponseAt, priority: e.priority, status: e.status });
    return { ...e, waitingHours: Math.round(age.waitingHours * 10) / 10, overdue: age.overdue, answered: age.answered };
}

const ListEnquiries = Pagination.extend({
    status: z.enum(ENQUIRY_STATUSES).optional(),
    kind: z.enum(ENQUIRY_KINDS).optional(),
    assignedTo: uuid.optional(),
    /** Matches a name, an address, an organisation, or the reference exactly. */
    search: z.string().trim().min(1).max(120).optional(),
});

const LIST_COLUMNS = `e.id, e.reference, e.kind, e.status, e.priority, e.name, e.email, e.phone, e.organisation, e.role,
   e.university_id AS "universityId", e.assigned_to AS "assignedTo", e.created_at AS "createdAt",
   e.first_response_at AS "firstResponseAt", e.closed_at AS "closedAt",
   e.converted_university_id AS "convertedUniversityId", e.converted_shop_id AS "convertedShopId"`;

/**
 * The public contact form. The only endpoint in PrintFlow that accepts a message
 * from someone with no account, which is the whole point: a university that has
 * never heard of us has no other way to start.
 */
@Controller("v1/enquiries")
export class EnquiriesController {
    constructor(
        @Inject(PG_POOL) private readonly pool: Pool,
        @Inject(CONFIG) private readonly cfg: AppConfig,
        @Inject(MAILER) private readonly mailer: Mailer,
        @Inject(RateLimiter) private readonly limiter: RateLimiter,
        @Inject(LOGGER) private readonly log: Logger,
    ) {}

    @Post()
    @HttpCode(201)
    async create(@Req() req: PfRequest, @Body() body: unknown) {
        // Generous enough that a university writing twice in a morning is fine, tight
        // enough that one machine cannot fill the inbox.
        await this.limiter.hit(`enquiry:ip:${req.ip}`, 5, 3600);
        await this.limiter.hit(`enquiry:ip-day:${req.ip}`, 20, 86_400);
        const input = parse(Schemas.CreateEnquiry, body);

        // The honeypot was filled in, so this was not a person. It is stored rather
        // than dropped — knowing how much of this arrives is worth one row — and the
        // answer is the same one a person gets, because telling a bot it was detected
        // only teaches whoever wrote it.
        const trapped = Boolean(input.website && input.website.trim());
        const score = spamScore(input);
        const reference = newEnquiryReference();

        const enquiry = await withTransaction(this.pool, async (c) => {
            const { rows } = await c.query<{ id: string; reference: string }>(
                `INSERT INTO enquiries (reference, kind, status, priority, name, email, phone, organisation, role, message, source, remote_ip, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'WEB', $11, $12)
         RETURNING id, reference`,
                [
                    reference,
                    input.kind,
                    trapped ? "SPAM" : "NEW",
                    trapped ? "LOW" : startingPriority(input.kind),
                    input.name,
                    input.email,
                    input.phone ?? null,
                    input.organisation ?? null,
                    input.role ?? null,
                    input.message,
                    req.ip ?? null,
                    req.header("user-agent")?.slice(0, 400) ?? null,
                ],
            );
            const row = rows[0]!;
            await c.query(`INSERT INTO enquiry_events (enquiry_id, kind, body, details) VALUES ($1, 'RECEIVED', $2, $3)`, [
                row.id,
                input.message,
                JSON.stringify({ spamScore: score, honeypot: trapped, suspected: score >= SPAM_SUSPECT_AT }),
            ]);
            await audit(c, {
                actorUserId: null,
                actorKind: "SYSTEM",
                action: "enquiry.received",
                entityType: "enquiry",
                entityId: row.id,
                requestId: req.id,
                details: { kind: input.kind, reference: row.reference, spamScore: score },
            });
            return row;
        });

        if (!trapped) {
            this.notifyTeam(enquiry.reference, input, score);
            this.acknowledge(input.email, input.name, enquiry.reference, input.kind);
        }

        // Everyone gets the same answer, with their reference, whether or not we
        // think it was a machine.
        return { reference: enquiry.reference, received: true };
    }

    /** Tells the team an enquiry has arrived. Never blocks the response. */
    private notifyTeam(reference: string, input: { kind: EnquiryKind; name: string; email: string; phone?: string; organisation?: string; role?: string; message: string }, score: number) {
        const where = `${this.cfg.PUBLIC_WEB_URL}/platform/enquiries`;
        const text = [
            `${ENQUIRY_KIND_LABELS[input.kind]} got in touch.`,
            ``,
            `Reference: ${reference}`,
            `Name:      ${input.name}`,
            `Email:     ${input.email}`,
            input.phone ? `Phone:     ${input.phone}` : null,
            input.organisation ? `Org:       ${input.organisation}` : null,
            input.role ? `Role:      ${input.role}` : null,
            score >= SPAM_SUSPECT_AT ? `\nThis one looks like spam (score ${score}). Check before replying.` : null,
            ``,
            input.message,
            ``,
            `Open it: ${where}`,
        ]
            .filter((l) => l !== null)
            .join("\n");

        if (this.cfg.devConsole) {
            devConsole("enquiry received", [
                { label: "Reference", value: reference },
                { label: "From", value: `${input.name} <${input.email}>` },
                { label: "About", value: ENQUIRY_KIND_LABELS[input.kind] },
                { label: "Inbox", value: where },
            ]);
        }
        if (!this.cfg.ENQUIRY_INBOX) {
            // Not a failure: the admin inbox still has it. Logged once so it is obvious
            // why no email arrived.
            this.log.info({ reference }, "enquiry stored; ENQUIRY_INBOX is unset so nobody was emailed");
            return;
        }
        void this.mailer.send({ to: this.cfg.ENQUIRY_INBOX, subject: `PrintFlow enquiry ${reference}: ${ENQUIRY_KIND_LABELS[input.kind]}`, text });
    }

    /** Tells the sender we have it, so they are not left wondering. */
    private acknowledge(to: string, name: string, reference: string, kind: EnquiryKind) {
        const firstName = name.trim().split(/\s+/)[0] ?? name;
        const text = [
            `Hello ${firstName},`,
            ``,
            `Thank you for getting in touch with PrintFlow. We have your message and someone will read it.`,
            ``,
            `Your reference is ${reference}. Quote it if you write to us again about this.`,
            kind === "UNIVERSITY"
                ? `\nFor universities we usually set up your campuses and price list with you on one call, your team approves the first shops, and students can order the same week.`
                : kind === "PRINT_SHOP"
                    ? `\nFor print shops we will tell you what we need to get you trading — including what happens if your university is not on PrintFlow yet, which is not a problem.`
                    : null,
            ``,
            `— PrintFlow`,
        ]
            .filter((l) => l !== null)
            .join("\n");
        void this.mailer.send({ to, subject: `We have your message (${reference})`, text });
    }
}

/**
 * The inbox. Reading is open to platform support; anything that creates a tenant
 * is an administrator's job, because it creates somewhere real money can move.
 */
@Controller("v1/platform/enquiries")
export class PlatformEnquiriesController {
    constructor(
        @Inject(PG_POOL) private readonly pool: Pool,
        @Inject(CONFIG) private readonly cfg: AppConfig,
        @Inject(Access) private readonly access: Access,
        @Inject(MAILER) private readonly mailer: Mailer,
    ) {}

    @Get()
    async list(@Req() req: PfRequest, @Query() query: unknown) {
        this.access.platform(req, ["PLATFORM_ADMIN", "PLATFORM_SUPPORT"]);
        const q = parse(ListEnquiries, query);
        const cursor = decodeCursor(q.cursor);
        const { rows } = await this.pool.query<EnquiryRow & { assignedName: string | null }>(
            `SELECT ${LIST_COLUMNS}, u.full_name AS "assignedName"
         FROM enquiries e LEFT JOIN users u ON u.id = e.assigned_to
        WHERE ($1::text IS NULL OR e.status = $1)
          AND ($2::text IS NULL OR e.kind = $2)
          AND ($3::uuid IS NULL OR e.assigned_to = $3)
          AND ($4::text IS NULL OR e.name ILIKE '%' || $4 || '%' OR e.email ILIKE '%' || $4 || '%'
               OR coalesce(e.organisation, '') ILIKE '%' || $4 || '%' OR e.reference = upper($4))
          AND ($5::timestamptz IS NULL OR (e.created_at, e.id) < ($5, $6))
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT $7`,
            [q.status ?? null, q.kind ?? null, q.assignedTo ?? null, q.search ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, q.limit + 1],
        );
        const page = rows.slice(0, q.limit).map(withAge);
        const counts = await this.pool.query<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM enquiries GROUP BY status`);
        return {
            items: page,
            nextCursor: rows.length > q.limit ? encodeCursor(page[page.length - 1]!.createdAt, page[page.length - 1]!.id) : null,
            counts: Object.fromEntries(counts.rows.map((r) => [r.status, r.n])),
            // The number that matters: people still waiting past the target for their priority.
            overdue: page.filter((p) => p.overdue).length,
        };
    }

    @Get(":enquiryId")
    async detail(@Req() req: PfRequest, @Param("enquiryId") idRaw: string) {
        this.access.platform(req, ["PLATFORM_ADMIN", "PLATFORM_SUPPORT"]);
        const id = parse(uuid, idRaw);
        const { rows } = await this.pool.query<EnquiryRow & { message: string }>(
            `SELECT ${LIST_COLUMNS}, e.message, e.source, e.user_agent AS "userAgent" FROM enquiries e WHERE e.id = $1`,
            [id],
        );
        if (!rows[0]) throw Errors.notFound("enquiry");
        const thread = await this.pool.query(
            `SELECT ev.id, ev.kind, ev.body, ev.details, ev.emailed, ev.created_at AS "createdAt", u.full_name AS "actorName"
         FROM enquiry_events ev LEFT JOIN users u ON u.id = ev.actor_user_id
        WHERE ev.enquiry_id = $1 ORDER BY ev.id`,
            [id],
        );
        const e = rows[0];
        return { ...withAge(e), thread: thread.rows, canConvert: canConvert(e.kind, e.status) };
    }

    /** Writes to the thread and, for a reply, sends it. */
    private async addEvent(
        c: PoolClient | Pool,
        enquiryId: string,
        kind: "REPLY" | "NOTE" | "STATUS" | "ASSIGNED" | "ESCALATED" | "CONVERTED",
        actorUserId: string,
        body: string | null,
        details: object = {},
        emailed = false,
    ) {
        await c.query(`INSERT INTO enquiry_events (enquiry_id, kind, actor_user_id, body, details, emailed) VALUES ($1, $2, $3, $4, $5, $6)`, [
            enquiryId,
            kind,
            actorUserId,
            body,
            JSON.stringify(details),
            emailed,
        ]);
    }

    private async load(id: string) {
        const { rows } = await this.pool.query<EnquiryRow & { message: string }>(`SELECT ${LIST_COLUMNS}, e.message FROM enquiries e WHERE e.id = $1`, [id]);
        if (!rows[0]) throw Errors.notFound("enquiry");
        return rows[0];
    }

    @Post(":enquiryId/reply")
    @HttpCode(201)
    async reply(@Req() req: PfRequest, @Param("enquiryId") idRaw: string, @Body() body: unknown) {
        const a = this.access.platform(req, ["PLATFORM_ADMIN", "PLATFORM_SUPPORT"]);
        const id = parse(uuid, idRaw);
        const input = parse(Schemas.EnquiryReply, body);
        const e = await this.load(id);

        const signature = this.cfg.ENQUIRY_INBOX ? `\n\n— PrintFlow\nReply to this message or write to ${this.cfg.ENQUIRY_INBOX}, quoting ${e.reference}.` : `\n\n— PrintFlow (${e.reference})`;
        await this.mailer.send({ to: e.email, subject: `Re: your message to PrintFlow (${e.reference})`, text: `${input.body}${signature}` });

        await withTransaction(this.pool, async (c) => {
            // The trigger stamps first_response_at off this row, so the reply is written
            // after it has actually been sent, never before.
            await this.addEvent(c, id, "REPLY", a.userId, input.body, {}, true);
            // Replying to something nobody had picked up moves it out of the new pile.
            if (e.status === "NEW") await c.query(`UPDATE enquiries SET status = 'OPEN', assigned_to = COALESCE(assigned_to, $2) WHERE id = $1`, [id, a.userId]);
            await audit(c, { actorUserId: a.userId, actorKind: "PLATFORM_ADMIN", action: "enquiry.replied", entityType: "enquiry", entityId: id, requestId: req.id });
        });
        return { sent: true, to: e.email };
    }

    @Post(":enquiryId/notes")
    @HttpCode(201)
    async note(@Req() req: PfRequest, @Param("enquiryId") idRaw: string, @Body() body: unknown) {
        const a = this.access.platform(req, ["PLATFORM_ADMIN", "PLATFORM_SUPPORT"]);
        const id = parse(uuid, idRaw);
        const input = parse(Schemas.EnquiryNote, body);
        await this.load(id);
        // Notes are never sent. The column says so, so nobody has to remember.
        await this.addEvent(this.pool, id, "NOTE", a.userId, input.body, {}, false);
        return { added: true };
    }

    @Patch(":enquiryId")
    async update(@Req() req: PfRequest, @Param("enquiryId") idRaw: string, @Body() body: unknown) {
        const a = this.access.platform(req, ["PLATFORM_ADMIN", "PLATFORM_SUPPORT"]);
        const id = parse(uuid, idRaw);
        const input = parse(Schemas.UpdateEnquiry, body);
        const e = await this.load(id);
        if (input.status && !canMoveEnquiry(e.status, input.status)) {
            throw Errors.rule(`an enquiry cannot go from ${e.status} to ${input.status}`, "INVALID_ENQUIRY_STATUS");
        }
        if (input.assignedTo) {
            const who = await this.pool.query(`SELECT 1 FROM users WHERE id = $1 AND status = 'ACTIVE' AND platform_role IS NOT NULL`, [input.assignedTo]);
            if (!who.rowCount) throw Errors.rule("enquiries can only be assigned to platform staff", "NOT_PLATFORM_STAFF");
        }
        return withTransaction(this.pool, async (c) => {
            const { rows } = await c.query<EnquiryRow>(
                `UPDATE enquiries SET status = COALESCE($2, status), priority = COALESCE($3, priority), kind = COALESCE($4, kind),
                assigned_to = CASE WHEN $5 THEN $6 ELSE assigned_to END
          WHERE id = $1 RETURNING ${LIST_COLUMNS.replace(/e\./g, "")}`,
                [id, input.status ?? null, input.priority ?? null, input.kind ?? null, "assignedTo" in input && input.assignedTo !== undefined, input.assignedTo ?? null],
            );
            if (input.status) await this.addEvent(c, id, "STATUS", a.userId, input.reason ?? null, { from: e.status, to: input.status });
            if ("assignedTo" in input && input.assignedTo !== undefined) await this.addEvent(c, id, "ASSIGNED", a.userId, null, { assignedTo: input.assignedTo });
            await audit(c, { actorUserId: a.userId, actorKind: "PLATFORM_ADMIN", action: "enquiry.updated", entityType: "enquiry", entityId: id, requestId: req.id, details: input });
            return withAge(rows[0]!);
        });
    }

    /**
     * Escalation is a status plus a note plus a louder email, and it exists so that
     * "this one needs someone senior" is one click rather than a conversation that
     * happens somewhere PrintFlow cannot see.
     */
    @Post(":enquiryId/escalate")
    @HttpCode(200)
    async escalate(@Req() req: PfRequest, @Param("enquiryId") idRaw: string, @Body() body: unknown) {
        const a = this.access.platform(req, ["PLATFORM_ADMIN", "PLATFORM_SUPPORT"]);
        const id = parse(uuid, idRaw);
        const { reason } = parse(Schemas.UpdateEnquiry, body);
        const e = await this.load(id);
        if (!canMoveEnquiry(e.status, "ESCALATED")) throw Errors.rule(`an enquiry cannot be escalated from ${e.status}`, "INVALID_ENQUIRY_STATUS");

        await withTransaction(this.pool, async (c) => {
            await c.query(`UPDATE enquiries SET status = 'ESCALATED', priority = 'URGENT' WHERE id = $1`, [id]);
            await this.addEvent(c, id, "ESCALATED", a.userId, reason ?? null, { from: e.status });
            await audit(c, { actorUserId: a.userId, actorKind: "PLATFORM_ADMIN", action: "enquiry.escalated", entityType: "enquiry", entityId: id, requestId: req.id, details: { reason } });
        });
        if (this.cfg.ENQUIRY_INBOX) {
            void this.mailer.send({
                to: this.cfg.ENQUIRY_INBOX,
                subject: `Escalated: ${e.reference} (${ENQUIRY_KIND_LABELS[e.kind]})`,
                text: `${e.name} <${e.email}>${e.organisation ? ` at ${e.organisation}` : ""} needs someone senior.\n\n${reason ?? "No reason given."}\n\n${this.cfg.PUBLIC_WEB_URL}/platform/enquiries/${id}`,
            });
        }
        return { status: "ESCALATED", priority: "URGENT" };
    }

    /**
     * Turns an enquiry into somewhere a shop can trade.
     *
     * If the enquirer is a university, the tenant is theirs from the start. If it is
     * a print shop whose university has never heard of us, the tenant is created
     * UNCLAIMED: PrintFlow stands in for university staff, so the shop can be
     * approved and start taking orders this week instead of waiting on a signature
     * from people who have not been asked yet.
     *
     * The converting administrator is added as an administrator of an unclaimed
     * tenant on purpose. It means every existing university screen, permission check
     * and audit trail works unchanged — no second, weaker authorisation path that
     * only applies to tenants nobody is watching.
     */
    @Post(":enquiryId/convert")
    @HttpCode(201)
    async convert(@Req() req: PfRequest, @Param("enquiryId") idRaw: string, @Body() body: unknown) {
        const a = this.access.platform(req, ["PLATFORM_ADMIN"]);
        const id = parse(uuid, idRaw);
        const input = parse(Schemas.ConvertEnquiry, body);
        const e = await this.load(id);
        if (!canConvert(e.kind, e.status)) throw Errors.rule("only an open university or print shop enquiry can be onboarded", "NOT_CONVERTIBLE");

        const result = await withTransaction(this.pool, async (c) => {
            let universityId = input.universityId ?? null;
            let unclaimed = false;

            if (universityId) {
                const exists = await c.query<{ tenancy: string }>(`SELECT tenancy FROM universities WHERE id = $1`, [universityId]);
                if (!exists.rows[0]) throw Errors.notFound("university");
                unclaimed = exists.rows[0].tenancy === "UNCLAIMED";
            } else {
                const uniName = input.universityName ?? e.organisation;
                if (!uniName) throw Errors.rule("give the university's name, or choose one we already have", "UNIVERSITY_NAME_REQUIRED");
                // A print shop cannot sign on behalf of a university, so the tenant we make
                // for them is explicitly nobody's until the university says otherwise.
                unclaimed = e.kind === "PRINT_SHOP";
                const slug = await freeSlug(c, slugifyUniversity(uniName));
                const created = await c.query<{ id: string }>(
                    `INSERT INTO universities (slug, name, status, tenancy, pricing_mode) VALUES ($1, $2, 'ACTIVE', $3, $4) RETURNING id`,
                    [
                        slug,
                        uniName,
                        unclaimed ? "UNCLAIMED" : "UNIVERSITY",
                        // With no university to publish a price list, the shop has to set its own.
                        input.pricingMode ?? (unclaimed ? "MERCHANT_CONTROLLED" : "UNIVERSITY_CONTROLLED"),
                    ],
                );
                universityId = created.rows[0]!.id;
                await audit(c, { universityId, actorUserId: a.userId, actorKind: "PLATFORM_ADMIN", action: "university.created", entityType: "university", entityId: universityId, requestId: req.id, details: { fromEnquiry: e.reference, tenancy: unclaimed ? "UNCLAIMED" : "UNIVERSITY" } });
            }

            // At least one campus, or students cannot register and shops cannot apply.
            const campus = await c.query<{ id: string }>(
                `INSERT INTO campuses (university_id, name) VALUES ($1, $2)
         ON CONFLICT (university_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
                [universityId, input.campusName],
            );

            // Someone has to be able to approve the shop. On an unclaimed tenant that is
            // us, through the ordinary university screens.
            if (unclaimed) {
                await c.query(
                    `INSERT INTO university_staff (user_id, university_id, role) VALUES ($1, $2, 'UNIVERSITY_ADMIN')
           ON CONFLICT DO NOTHING`,
                    [a.userId, universityId],
                );
            }

            await c.query(
                `UPDATE enquiries SET status = 'CONVERTED', university_id = $2, converted_university_id = $2, assigned_to = COALESCE(assigned_to, $3) WHERE id = $1`,
                [id, universityId, a.userId],
            );
            await this.addEvent(c, id, "CONVERTED", a.userId, input.note ?? null, { universityId, campusId: campus.rows[0]!.id, unclaimed });
            await audit(c, { universityId, actorUserId: a.userId, actorKind: "PLATFORM_ADMIN", action: "enquiry.converted", entityType: "enquiry", entityId: id, requestId: req.id, details: { universityId, unclaimed } });
            return { universityId: universityId!, campusId: campus.rows[0]!.id, unclaimed };
        });

        // Tell them what to do next, in the order they have to do it.
        const steps =
            e.kind === "PRINT_SHOP"
                ? [
                    `1. Create a PrintFlow account: ${this.cfg.PUBLIC_WEB_URL}/register`,
                    `2. Register your shop: ${this.cfg.PUBLIC_WEB_URL}/shop/apply`,
                    `3. We approve it, you set your prices and add your printers, and students can order.`,
                ]
                : [
                    `1. Your administrators create accounts: ${this.cfg.PUBLIC_WEB_URL}/register`,
                    `2. Tell us their email addresses and we will give them access.`,
                    `3. You publish your price list and approve your first shops.`,
                ];
        void this.mailer.send({
            to: e.email,
            subject: `You're set up on PrintFlow (${e.reference})`,
            text: [
                `Hello ${e.name.trim().split(/\s+/)[0]},`,
                ``,
                result.unclaimed
                    ? `We've set you up so you can start trading. Your university isn't on PrintFlow yet, so we're looking after the campus side for you — you set your own prices, and nothing changes for you if they join us later.`
                    : `We've set up your campus on PrintFlow.`,
                ``,
                ...steps,
                ``,
                `— PrintFlow`,
            ].join("\n"),
        });

        return { ...result, enquiryStatus: "CONVERTED" };
    }
}

/** The first free slug based on a name, so two "City Polytechnic"s can coexist. */
async function freeSlug(c: PoolClient | Pool, base: string): Promise<string> {
    for (let i = 0; i < 50; i++) {
        const candidate = i === 0 ? base : `${base}-${i + 1}`;
        const taken = await c.query(`SELECT 1 FROM universities WHERE slug = $1`, [candidate]);
        if (!taken.rowCount) return candidate;
    }
    throw Errors.rule("could not find a free short name for this university; set one by hand", "SLUG_UNAVAILABLE");
}