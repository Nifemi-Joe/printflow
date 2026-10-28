import { randomInt } from "node:crypto";

/**
 * Enquiries: the one door into PrintFlow for people who do not have an account
 * yet. A university wanting to onboard, a print shop wanting to trade, a student
 * who is stuck — all of them arrive here, and this file decides what may happen
 * to one afterwards.
 *
 * The rules are deliberately few. An inbox that is hard to work is an inbox that
 * stops being worked, and an enquiry nobody answered is a university nobody
 * onboarded.
 */

export const ENQUIRY_KINDS = ["UNIVERSITY", "PRINT_SHOP", "STUDENT", "OTHER"] as const;
export type EnquiryKind = (typeof ENQUIRY_KINDS)[number];

export const ENQUIRY_STATUSES = ["NEW", "OPEN", "WAITING_ON_THEM", "ESCALATED", "CONVERTED", "CLOSED", "SPAM"] as const;
export type EnquiryStatus = (typeof ENQUIRY_STATUSES)[number];

export const ENQUIRY_PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
export type EnquiryPriority = (typeof ENQUIRY_PRIORITIES)[number];

export const ENQUIRY_KIND_LABELS: Record<EnquiryKind, string> = {
    UNIVERSITY: "A university",
    PRINT_SHOP: "A print shop",
    STUDENT: "A student",
    OTHER: "Something else",
};

export const ENQUIRY_STATUS_LABELS: Record<EnquiryStatus, string> = {
    NEW: "New",
    OPEN: "Being handled",
    WAITING_ON_THEM: "Waiting on them",
    ESCALATED: "Escalated",
    CONVERTED: "Onboarded",
    CLOSED: "Closed",
    SPAM: "Spam",
};

/** Terminal: the conversation is over and the clock has stopped. */
export const ENQUIRY_TERMINAL: readonly EnquiryStatus[] = ["CONVERTED", "CLOSED", "SPAM"];

const TRANSITIONS: Record<EnquiryStatus, readonly EnquiryStatus[]> = {
    NEW: ["OPEN", "WAITING_ON_THEM", "ESCALATED", "CONVERTED", "CLOSED", "SPAM"],
    OPEN: ["WAITING_ON_THEM", "ESCALATED", "CONVERTED", "CLOSED", "SPAM"],
    WAITING_ON_THEM: ["OPEN", "ESCALATED", "CONVERTED", "CLOSED", "SPAM"],
    ESCALATED: ["OPEN", "WAITING_ON_THEM", "CONVERTED", "CLOSED"],
    // Reopening a finished enquiry is allowed, because people do write back. What is
    // not allowed is quietly turning an onboarded university back into an enquiry:
    // the shop and tenant it created are still there.
    CONVERTED: ["OPEN", "CLOSED"],
    CLOSED: ["OPEN"],
    SPAM: ["OPEN"],
};

export function canMoveEnquiry(from: EnquiryStatus, to: EnquiryStatus): boolean {
    return from === to || (TRANSITIONS[from]?.includes(to) ?? false);
}

/**
 * What we aim to answer within, in hours. Not a promise to anyone outside the
 * team: it is the number the inbox turns red against, so that an enquiry which
 * has been sitting for two days is impossible to miss rather than merely
 * available to find.
 */
export const RESPONSE_TARGET_HOURS: Record<EnquiryPriority, number> = { URGENT: 2, HIGH: 8, NORMAL: 24, LOW: 72 };

/**
 * A new enquiry's starting priority. A university asking to onboard is the most
 * valuable message this company receives, and a shop that cannot trade is losing
 * money today; both outrank a general question.
 */
export function startingPriority(kind: EnquiryKind): EnquiryPriority {
    if (kind === "UNIVERSITY") return "HIGH";
    if (kind === "PRINT_SHOP") return "HIGH";
    return "NORMAL";
}

export interface EnquiryAge {
    /** Hours since it arrived, or since it was answered if it has been. */
    waitingHours: number;
    /** Past the target for its priority and still unanswered. */
    overdue: boolean;
    answered: boolean;
}

export function enquiryAge(
    e: { createdAt: string | Date; firstResponseAt: string | Date | null; priority: EnquiryPriority; status: EnquiryStatus },
    now: Date = new Date(),
): EnquiryAge {
    const created = new Date(e.createdAt).getTime();
    const answered = e.firstResponseAt !== null;
    const until = answered ? new Date(e.firstResponseAt!).getTime() : now.getTime();
    const waitingHours = Math.max(0, (until - created) / 3_600_000);
    const finished = ENQUIRY_TERMINAL.includes(e.status);
    return { waitingHours, answered, overdue: !answered && !finished && waitingHours > RESPONSE_TARGET_HOURS[e.priority] };
}

/** Only these kinds describe an organisation we could onboard. */
export function canConvert(kind: EnquiryKind, status: EnquiryStatus): boolean {
    return (kind === "UNIVERSITY" || kind === "PRINT_SHOP") && !ENQUIRY_TERMINAL.includes(status);
}

const REF_ALPHABET = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** Same shape and alphabet as an order reference, so support can read it aloud. */
export function newEnquiryReference(): string {
    let s = "";
    for (let i = 0; i < 8; i++) s += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
    return `ENQ-${s}`;
}

/**
 * A slug for a university we are creating on someone else's behalf. Derived from
 * the name they gave us, so an admin can recognise it later, and suffixed by the
 * caller when it collides.
 */
export function slugifyUniversity(name: string): string {
    const base = name
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48);
    return base.length >= 2 ? base : "university";
}

/**
 * Cheap, boring spam signals. Deliberately not a filter that rejects: a real
 * university writing a short message must never be turned away by a heuristic.
 * A high score only suggests SPAM to the person reading the inbox.
 */
export function spamScore(e: { name: string; email: string; message: string; organisation?: string | null }): number {
    let score = 0;
    const msg = e.message.toLowerCase();
    const links = (msg.match(/https?:\/\//g) ?? []).length;
    if (links >= 3) score += 2;
    else if (links === 2) score += 1;
    if (/\b(seo|backlink|crypto|forex|casino|viagra|loan offer|bitcoin)\b/.test(msg)) score += 3;
    if (/(.)\1{9,}/.test(msg)) score += 2;
    // An address and a name that share nothing, in a message with links, is a
    // pattern; on its own it means nothing, which is why it scores one.
    if (links > 0 && !e.email.toLowerCase().includes(e.name.toLowerCase().split(/\s+/)[0] ?? "\u0000")) score += 1;
    if (e.message.length < 25) score += 1;
    return score;
}

export const SPAM_SUSPECT_AT = 4;