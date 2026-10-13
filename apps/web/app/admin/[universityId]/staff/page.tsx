"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { ErrorNotice, PageHead, Skeleton } from "@/components/ui";
import { api } from "@/lib/api";
import { useData } from "@/lib/use-data";

const ROLE: Record<string, string> = { UNIVERSITY_ADMIN: "Administrator", UNIVERSITY_FINANCE: "Finance", UNIVERSITY_SUPPORT: "Support" };

export default function UniStaff() {
  const { universityId } = useParams<{ universityId: string }>();
  const base = `/admin/universities/${universityId}`;
  const { data, error, loading, reload } = useData<{ items: Array<{ id: string; role: string; fullName: string; email: string; mfaEnrolled: boolean }> }>(`${base}/staff`);
  const [actionError, setActionError] = useState<unknown>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setActionError(e);
    }
  };
  return (
    <>
      <PageHead title="Staff" />
      <ErrorNotice error={error ?? actionError} onRetry={reload} />
      {loading ? (
        <Skeleton />
      ) : (
        <div className="sheet">
          {data?.items.map((s) => (
            <div key={s.id} className="ticket-line">
              <span>
                <strong>{s.fullName}</strong> <span className="muted">{s.email}</span>
                <br />
                {ROLE[s.role]}. {s.mfaEnrolled ? "Two-step sign-in set up." : "Two-step sign-in not set up."}
              </span>
              <button className="btn btn-danger btn-small" onClick={() => window.confirm(`Remove ${s.fullName}?`) && run(() => api(`${base}/staff/${s.id}`, { method: "DELETE" }))}>
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
      <form
        className="sheet"
        style={{ marginTop: "1.5rem" }}
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const f = new FormData(form);
          void run(async () => {
            await api(`${base}/staff`, { method: "POST", body: { email: f.get("email"), role: f.get("role") } });
            form.reset();
          });
        }}
      >
        <h3>Add staff</h3>
        <p className="muted">Finance staff can see money and issue refunds. Support staff can see orders and disputes but cannot refund.</p>
        <div className="field">
          <label htmlFor="us-email">Their account email</label>
          <input id="us-email" name="email" type="email" required />
        </div>
        <div className="field">
          <label htmlFor="us-role">Role</label>
          <select id="us-role" name="role">
            {Object.entries(ROLE).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <button className="btn btn-primary" type="submit">
          Add staff
        </button>
      </form>
    </>
  );
}
