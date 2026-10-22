"use client";

import { naira } from "@/lib/format";

export interface Trust {
    kind: "BUSINESS" | "STUDENT_RUN";
    level: "UNVERIFIED" | "EMAIL_VERIFIED" | "MATRIC_VERIFIED" | "UNIVERSITY_APPROVED";
    badge: { label: string; detail: string; tone: "good" | "caution" | "warn" };
    limits?: { needsAcknowledgement: boolean; orderCapKobo: number | null; listedByDefault: boolean };
}

const PILL: Record<Trust["badge"]["tone"], string> = { good: "pill-go", caution: "pill-warn", warn: "pill-bad" };

/**
 * Who is behind a shop. Shown wherever a student is choosing one or looking at an order,
 * because the difference between a registered shop and an unchecked stranger with a
 * printer is the thing they most need to know and cannot otherwise see.
 */
export function TrustBadge({ trust, showDetail = false }: { trust: Trust; showDetail?: boolean }) {
    return (
        <>
            <span className={`pill ${PILL[trust.badge.tone]}`}>{trust.badge.label}</span>
            {showDetail && (
                <span className="muted" style={{ fontWeight: 400 }}>
          {" "}
                    {trust.badge.detail}
        </span>
            )}
        </>
    );
}

/**
 * The warning a student reads before sending a document to a provider whose identity is
 * not fully proven, with the box they have to tick. Nothing is hidden behind a link:
 * the limit and the reason are on the page.
 */
export function UnverifiedProviderNotice({
                                             trust,
                                             shopName,
                                             agreed,
                                             onAgree,
                                         }: {
    trust: Trust;
    shopName: string;
    agreed: boolean;
    onAgree: (v: boolean) => void;
}) {
    if (!trust.limits?.needsAcknowledgement) return null;
    const cap = trust.limits.orderCapKobo;
    return (
        <div className={`notice ${trust.badge.tone === "warn" ? "notice-error" : "notice-warn"}`} role="note">
            <p>
                <strong>{shopName} is a student, not a registered shop.</strong> {trust.badge.detail}
            </p>
            <p className="muted" style={{ fontSize: "var(--t-sm)" }}>
                They will be able to open your document. Do not send anything you would not show them in person, such as medical letters or bank statements.
                {cap !== null ? ` Orders here are capped at ${naira(cap)} until their matric number is confirmed.` : ""}
            </p>
            <label className="choice" style={{ display: "block", marginTop: "var(--space-3)" }}>
                <input type="checkbox" checked={agreed} onChange={(e) => onAgree(e.target.checked)} />
                <span style={{ padding: "var(--space-3) var(--space-4)" }}>I understand, and I still want to use this shop</span>
            </label>
        </div>
    );
}