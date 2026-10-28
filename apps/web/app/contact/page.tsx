import type { Metadata } from "next";
import Link from "next/link";
import { ContactForm } from "@/components/landing/ContactForm";
import { Logo } from "@/components/ui";

export const metadata: Metadata = {
    title: "Contact PrintFlow",
    description: "Bring PrintFlow to your university, register a print shop, or ask us a question.",
};

/** `?as=shop` arrives from the landing page, already knowing who is writing. */
const FROM_LINK: Record<string, "UNIVERSITY" | "PRINT_SHOP" | "STUDENT" | "OTHER"> = {
    shop: "PRINT_SHOP",
    university: "UNIVERSITY",
    student: "STUDENT",
};

/**
 * One door for everyone without an account. A page of its own as well as a
 * section on the landing page, so it can be linked to from an email, a poster or
 * a conversation — and so the shop whose university has never heard of us has
 * somewhere to go that is not the application form they cannot complete.
 */
export default async function Contact({ searchParams }: { searchParams: Promise<{ as?: string }> }) {
    const { as } = await searchParams;
    const kind = FROM_LINK[as ?? ""] ?? "UNIVERSITY";

    return (
        <main id="main" style={{ minHeight: "100vh", padding: "var(--space-7) var(--space-4)" }}>
            <div style={{ width: "min(680px, 100%)", margin: "0 auto" }}>
                <Link href="/" className="brand" style={{ marginBottom: "var(--space-6)" }}>
                    <Logo /> PrintFlow
                </Link>
                <h1 style={{ fontSize: "var(--t-3xl)", letterSpacing: "-0.03em", maxWidth: "16ch" }}>Talk to us</h1>
                <p className="lede" style={{ maxWidth: "52ch" }}>
                    Whether you want PrintFlow on your campus, you run a print shop, or something has gone wrong with an order — this reaches the same people, and we answer.
                </p>
                {kind === "PRINT_SHOP" && (
                    <div className="notice" role="note" style={{ marginTop: "var(--space-5)" }}>
                        <p>
                            <strong>Your university doesn&apos;t have to be on PrintFlow for you to use it.</strong> Tell us which campus you&apos;re next to and we&apos;ll set you up to
                            take orders. We look after the campus side until your university joins us, and nothing changes for you when they do.
                        </p>
                    </div>
                )}
                <div className="sheet" style={{ marginTop: "var(--space-6)" }}>
                    <ContactForm initialKind={kind} />
                </div>
            </div>
        </main>
    );
}