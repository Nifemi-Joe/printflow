"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { ErrorNotice, PageHead, Skeleton } from "@/components/ui";
import { naira, STATUS_LABEL } from "@/lib/format";
import { useData } from "@/lib/use-data";

interface Overview {
  university: { name: string; status: string; pricingMode: string };
  shopsByStatus: Array<{ status: string; n: number }>;
  ordersLast30DaysByStatus: Array<{ status: string; n: number }>;
  paymentsLast30DaysKobo: number;
  refundsLast30DaysKobo: number;
  openDisputes: number;
  openPrivacyRequests: number;
  publishedCampusRateCards: number;
  providers: { waitingChecks: number; studentRun: number; unverifiedTrading: number };
}

export default function AdminOverview() {
  const { universityId } = useParams<{ universityId: string }>();
  const { data: o, error, loading, reload } = useData<Overview>(`/admin/universities/${universityId}/overview`);
  if (loading) return <Skeleton lines={6} />;
  if (!o) return <ErrorNotice error={error} onRetry={reload} />;
  const pending = o.shopsByStatus.find((s) => s.status === "PENDING_APPROVAL")?.n ?? 0;
  const b = `/admin/${universityId}`;
  const todo = [
    pending > 0 && { href: `${b}/shops`, text: `${pending} shop${pending === 1 ? "" : "s"} waiting for approval` },
    o.openDisputes > 0 && { href: `${b}/disputes`, text: `${o.openDisputes} open dispute${o.openDisputes === 1 ? "" : "s"}` },
    o.providers.waitingChecks > 0 && {
      href: `${b}/providers`,
      text: `${o.providers.waitingChecks} print shop${o.providers.waitingChecks === 1 ? "" : "s"} waiting for you to confirm who they are`,
    },
    o.openPrivacyRequests > 0 && { href: `${b}/privacy`, text: `${o.openPrivacyRequests} privacy request${o.openPrivacyRequests === 1 ? "" : "s"} to handle` },
    o.university.pricingMode === "UNIVERSITY_CONTROLLED" && o.publishedCampusRateCards === 0 && { href: `${b}/pricing`, text: "Publish a campus price list so students can order" },
  ].filter(Boolean) as Array<{ href: string; text: string }>;

  return (
      <>
        <PageHead title={o.university.name} />
        {todo.length > 0 && (
            <div className="sheet" style={{ marginBottom: "1.5rem" }}>
              <h2 style={{ fontSize: "var(--t-xl)" }}>Needs your attention</h2>
              <ul className="plain-list">
                {todo.map((t) => (
                    <li key={t.href}>
                      <Link href={t.href}>{t.text}</Link>
                    </li>
                ))}
              </ul>
            </div>
        )}
        <div className="grid-2">
          <div className="sheet">
            <h2 style={{ fontSize: "var(--t-xl)" }}>Money, last 30 days</h2>
            <p className="num" style={{ fontFamily: "var(--font-display)", fontSize: "var(--t-3xl)", color: "var(--emerald-deep)", margin: 0 }}>
              {naira(o.paymentsLast30DaysKobo)}
            </p>
            <p className="muted">paid by students. Refunded: {naira(o.refundsLast30DaysKobo)}.</p>
            <p>Pricing: {o.university.pricingMode === "UNIVERSITY_CONTROLLED" ? "set by the university" : "set by shops within agreed limits"}.</p>
            {o.providers.studentRun > 0 && (
                <p className="muted">
                  {o.providers.studentRun} student{o.providers.studentRun === 1 ? "" : "s"} print for others
                  {o.providers.unverifiedTrading > 0 ? `, ${o.providers.unverifiedTrading} of them still unverified` : ", all verified"}.
                </p>
            )}
          </div>
          <div className="sheet">
            <h2 style={{ fontSize: "var(--t-xl)" }}>Orders, last 30 days</h2>
            {o.ordersLast30DaysByStatus.length === 0 ? (
                <p className="muted">No orders yet.</p>
            ) : (
                <ul className="plain-list">
                  {o.ordersLast30DaysByStatus.map((s) => (
                      <li key={s.status}>
                        {STATUS_LABEL[s.status] ?? s.status}: {s.n}
                      </li>
                  ))}
                </ul>
            )}
          </div>
        </div>
      </>
  );
}
