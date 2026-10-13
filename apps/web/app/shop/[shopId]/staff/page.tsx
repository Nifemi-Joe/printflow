"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { ErrorNotice, PageHead, Skeleton } from "@/components/ui";
import { api } from "@/lib/api";
import { useData } from "@/lib/use-data";

const PERMS: Array<[string, string]> = [
  ["orders.view", "See the queue and orders"],
  ["orders.accept", "Accept or reject jobs"],
  ["orders.produce", "Print, pause and report problems"],
  ["orders.qa", "Do quality checks"],
  ["orders.collect", "Hand over prints"],
  ["documents.download", "Download print files"],
  ["devices.manage", "Add and rename printers"],
  ["catalogue.manage", "Edit shop details"],
  ["pricing.manage", "Edit prices"],
  ["staff.manage", "Manage staff"],
  ["reports.view", "See reports"],
];

interface Member {
  id: string;
  role: string;
  permissions: string[];
  fullName: string;
  email: string;
  mfaEnrolled: boolean;
}

export default function Staff() {
  const { shopId } = useParams<{ shopId: string }>();
  const { data, error, loading, reload } = useData<{ items: Member[] }>(`/shops/${shopId}/staff`);
  const [actionError, setActionError] = useState<unknown>(null);
  const [editing, setEditing] = useState<string | null>(null);
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
        <div className="stack">
          {data?.items.map((m) => (
            <div key={m.id} className="sheet">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span>
                  <strong>{m.fullName}</strong> <span className="muted">{m.email}</span>
                  <br />
                  <span className="muted">
                    {m.role.charAt(0) + m.role.slice(1).toLowerCase()}. {m.mfaEnrolled ? "Two-step sign-in set up." : "Has not set up two-step sign-in yet."}
                  </span>
                </span>
                {m.role !== "OWNER" && (
                  <span className="row">
                    <button className="btn btn-quiet btn-small" onClick={() => setEditing(editing === m.id ? null : m.id)} aria-expanded={editing === m.id}>
                      Permissions
                    </button>
                    <button className="btn btn-danger btn-small" onClick={() => window.confirm(`Remove ${m.fullName} from this shop?`) && run(() => api(`/shops/${shopId}/staff/${m.id}`, { method: "DELETE" }))}>
                      Remove
                    </button>
                  </span>
                )}
              </div>
              {editing === m.id && (
                <form
                  style={{ marginTop: "1rem" }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    const perms = new FormData(e.currentTarget).getAll("p").map(String);
                    void run(async () => {
                      await api(`/shops/${shopId}/staff/${m.id}`, { method: "PATCH", body: { permissions: perms } });
                      setEditing(null);
                    });
                  }}
                >
                  {PERMS.map(([p, l]) => (
                    <label key={p} className="row" style={{ marginBottom: "0.35rem" }}>
                      <input type="checkbox" name="p" value={p} defaultChecked={m.permissions.includes(p)} /> {l}
                    </label>
                  ))}
                  <button className="btn btn-primary btn-small" type="submit">
                    Save permissions
                  </button>
                </form>
              )}
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
            await api(`/shops/${shopId}/staff`, { method: "POST", body: { email: f.get("email"), role: f.get("role") } });
            form.reset();
          });
        }}
      >
        <h3>Add a staff member</h3>
        <p className="muted">They need a PrintFlow account first. Operators can print, check quality and hand over prints; managers can also accept jobs and manage printers.</p>
        <div className="field">
          <label htmlFor="staff-email">Their account email</label>
          <input id="staff-email" name="email" type="email" required />
        </div>
        <div className="field">
          <label htmlFor="staff-role">Role</label>
          <select id="staff-role" name="role">
            <option value="OPERATOR">Operator</option>
            <option value="MANAGER">Manager</option>
          </select>
        </div>
        <button className="btn btn-primary" type="submit">
          Add staff member
        </button>
      </form>
    </>
  );
}
