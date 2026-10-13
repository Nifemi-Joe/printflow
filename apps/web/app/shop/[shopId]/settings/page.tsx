"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { ErrorNotice, PageHead, Skeleton, StatusPill } from "@/components/ui";
import { api } from "@/lib/api";
import { useData } from "@/lib/use-data";

const DAYS = [
  ["mon", "Monday"],
  ["tue", "Tuesday"],
  ["wed", "Wednesday"],
  ["thu", "Thursday"],
  ["fri", "Friday"],
  ["sat", "Saturday"],
  ["sun", "Sunday"],
] as const;

interface Shop {
  name: string;
  status: string;
  acceptingOrders: boolean;
  locationNote: string | null;
  openingHours: Record<string, Array<[string, string]>>;
  campusName: string;
  universityName: string;
  pickupLocations: Array<{ id: string; name: string; isActive: boolean }>;
}

export default function Settings() {
  const { shopId } = useParams<{ shopId: string }>();
  const { data: s, error, loading, reload } = useData<Shop>(`/shops/${shopId}`);
  const [actionError, setActionError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    setSaved(false);
    try {
      await fn();
      setSaved(true);
      await reload();
    } catch (e) {
      setActionError(e);
    }
  };
  if (loading) return <Skeleton />;
  if (!s) return <ErrorNotice error={error} onRetry={reload} />;

  return (
    <>
      <PageHead title={s.name}>
        <StatusPill status={s.status} label={s.status === "PENDING_APPROVAL" ? "Waiting for university approval" : s.status.toLowerCase()} />
      </PageHead>
      <p className="muted">
        {s.campusName}, {s.universityName}
      </p>
      {saved && (
        <div className="notice" role="status">
          <p>Saved.</p>
        </div>
      )}
      <ErrorNotice error={actionError} />
      <div className="grid-2" style={{ alignItems: "start" }}>
        <div className="sheet">
          <h2 style={{ fontSize: "var(--t-xl)" }}>Taking orders</h2>
          <p>{s.acceptingOrders ? "Students can send you new jobs." : "Students cannot send you new jobs right now. Jobs already paid stay in your queue."}</p>
          <button className={`btn ${s.acceptingOrders ? "btn-danger" : "btn-primary"}`} disabled={s.status !== "APPROVED"} onClick={() => run(() => api(`/shops/${shopId}`, { method: "PATCH", body: { acceptingOrders: !s.acceptingOrders } }))}>
            {s.acceptingOrders ? "Stop taking orders" : "Start taking orders"}
          </button>
        </div>

        <form
          className="sheet"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const hours: Record<string, Array<[string, string]>> = {};
            for (const [d] of DAYS) {
              const o = String(f.get(`${d}-open`) ?? "");
              const c = String(f.get(`${d}-close`) ?? "");
              hours[d] = o && c ? [[o, c]] : [];
            }
            void run(() => api(`/shops/${shopId}`, { method: "PATCH", body: { openingHours: hours, locationNote: String(f.get("note") || "") || null } }));
          }}
        >
          <h2 style={{ fontSize: "var(--t-xl)" }}>Opening hours and location</h2>
          {DAYS.map(([d, l]) => (
            <div key={d} className="row" style={{ marginBottom: "0.5rem" }}>
              <span style={{ width: 100 }}>{l}</span>
              <input aria-label={`${l} opens`} type="time" name={`${d}-open`} defaultValue={s.openingHours[d]?.[0]?.[0] ?? ""} style={{ width: 130 }} />
              <input aria-label={`${l} closes`} type="time" name={`${d}-close`} defaultValue={s.openingHours[d]?.[0]?.[1] ?? ""} style={{ width: 130 }} />
            </div>
          ))}
          <div className="field">
            <label htmlFor="note">How to find the shop</label>
            <textarea id="note" name="note" defaultValue={s.locationNote ?? ""} maxLength={500} />
          </div>
          <button className="btn btn-primary" type="submit">
            Save
          </button>
        </form>

        <div className="sheet">
          <h2 style={{ fontSize: "var(--t-xl)" }}>Pickup points</h2>
          {s.pickupLocations.map((p) => (
            <div key={p.id} className="ticket-line">
              <span>
                {p.name} {!p.isActive && <span className="muted">(not in use)</span>}
              </span>
              <button className="btn btn-quiet btn-small" onClick={() => run(() => api(`/shops/${shopId}/pickup-locations/${p.id}`, { method: "PATCH", body: { isActive: !p.isActive } }))}>
                {p.isActive ? "Stop using" : "Use again"}
              </button>
            </div>
          ))}
          <form
            className="row"
            style={{ marginTop: "1rem", alignItems: "flex-end" }}
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget;
              const name = String(new FormData(form).get("name"));
              void run(async () => {
                await api(`/shops/${shopId}/pickup-locations`, { method: "POST", body: { name } });
                form.reset();
              });
            }}
          >
            <div className="field" style={{ margin: 0, flex: 1, minWidth: 180 }}>
              <label htmlFor="pl">New pickup point</label>
              <input id="pl" name="name" required minLength={2} placeholder="e.g. Faculty of Science foyer" />
            </div>
            <button className="btn btn-primary" type="submit">
              Add
            </button>
          </form>
        </div>
      </div>
    </>
  );
}
