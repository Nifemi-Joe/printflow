"use client";

import { useParams } from "next/navigation";
import { ErrorNotice, PageHead, Skeleton } from "@/components/ui";
import { naira, STATUS_LABEL } from "@/lib/format";
import { useData } from "@/lib/use-data";

interface Summary {
  ordersByStatus: Array<{ status: string; n: number }>;
  paidOrders: number;
  collectedRevenueKobo: number;
  platformFeesKobo: number;
  turnaround: { medianMinutes: number | null; p90Minutes: number | null };
  qualityChecks: { pass: number; fail: number };
}
interface Recon {
  days: Array<{ day: string; paymentsKobo: number; refundsKobo: number; collectedRevenueKobo: number; collectedOrders: number }>;
}

export default function Reports() {
  const { shopId } = useParams<{ shopId: string }>();
  const s = useData<Summary>(`/shops/${shopId}/reports/summary`);
  const r = useData<Recon>(`/shops/${shopId}/reports/reconciliation`);
  if (s.loading || r.loading) return <Skeleton lines={6} />;
  const qaTotal = (s.data?.qualityChecks.pass ?? 0) + (s.data?.qualityChecks.fail ?? 0);
  const days = (r.data?.days ?? []).filter((d) => d.paymentsKobo || d.refundsKobo || d.collectedOrders);

  return (
    <>
      <PageHead title="Reports" />
      <p className="muted">Last 30 days.</p>
      <ErrorNotice error={s.error ?? r.error} />
      {s.data && (
        <div className="grid-2">
          <div className="sheet">
            <h2 style={{ fontSize: "var(--t-xl)" }}>Revenue from collected jobs</h2>
            <p style={{ fontFamily: "var(--font-display)", fontSize: "var(--t-3xl)", color: "var(--emerald-deep)", margin: 0 }} className="num">
              {naira(s.data.collectedRevenueKobo)}
            </p>
            <p className="muted">{s.data.paidOrders} paid orders. Service fees collected by PrintFlow on these: {naira(s.data.platformFeesKobo)}.</p>
          </div>
          <div className="sheet">
            <h2 style={{ fontSize: "var(--t-xl)" }}>Turnaround and quality</h2>
            <p>
              Paid to ready: {s.data.turnaround.medianMinutes !== null ? `${s.data.turnaround.medianMinutes} min typical, ${s.data.turnaround.p90Minutes} min for the slowest tenth` : "not enough finished jobs yet"}.
            </p>
            <p>{qaTotal ? `${s.data.qualityChecks.pass} of ${qaTotal} quality checks passed first time.` : "No quality checks recorded yet."}</p>
            <ul className="plain-list">
              {s.data.ordersByStatus.map((x) => (
                <li key={x.status}>
                  {STATUS_LABEL[x.status] ?? x.status}: {x.n}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <div className="sheet table-wrap" tabIndex={0} role="region" aria-label="Scrollable table" style={{ marginTop: "1.5rem" }}>
        <h2 style={{ fontSize: "var(--t-xl)" }}>Daily reconciliation</h2>
        {days.length === 0 ? (
          <p className="muted">No payments, refunds or collections in this period.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col" className="num">Payments in</th>
                <th scope="col" className="num">Refunds out</th>
                <th scope="col" className="num">Jobs collected</th>
                <th scope="col" className="num">Collected value</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.day}>
                  <td>{new Date(d.day).toLocaleDateString("en-NG", { day: "numeric", month: "short" })}</td>
                  <td className="num">{naira(d.paymentsKobo)}</td>
                  <td className="num">{naira(d.refundsKobo)}</td>
                  <td className="num">{d.collectedOrders}</td>
                  <td className="num">{naira(d.collectedRevenueKobo)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
