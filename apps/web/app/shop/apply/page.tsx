"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AuthFrame } from "@/components/AuthFrame";
import { ErrorNotice } from "@/components/ui";
import { api } from "@/lib/api";
import { useRequireSession } from "@/lib/session";
import { useData } from "@/lib/use-data";

export default function ApplyShop() {
  const { me, refresh } = useRequireSession();
  const router = useRouter();
  const unis = useData<{ items: Array<{ id: string; name: string }> }>("/universities");
  const [uni, setUni] = useState("");
  const detail = useData<{ campuses: Array<{ id: string; name: string }> }>(uni ? `/universities/${uni}` : null);
  const [error, setError] = useState<unknown>(null);

  return (
    <AuthFrame title="Register a print shop" footer={<Link href="/">Back to PrintFlow</Link>}>
      <p className="muted">Your university reviews every shop before it can take orders. You will be the shop&apos;s owner and can add staff afterwards.</p>
      {!me ? null : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            setError(null);
            try {
              const r = await api<{ id: string }>("/shops", { method: "POST", body: { universityId: uni, campusId: f.get("campus"), name: f.get("name"), locationNote: f.get("note") || undefined } });
              await refresh();
              router.replace(`/shop/${r.id}/settings`);
            } catch (err) {
              setError(err);
            }
          }}
        >
          <ErrorNotice error={error} />
          <div className="field">
            <label htmlFor="name">Shop name</label>
            <input id="name" name="name" required minLength={2} maxLength={120} />
          </div>
          <div className="field">
            <label htmlFor="uni">University</label>
            <select id="uni" value={uni} onChange={(e) => setUni(e.target.value)} required>
              <option value="">Choose a university</option>
              {unis.data?.items.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="campus">Campus</label>
            <select id="campus" name="campus" required disabled={!detail.data}>
              {detail.data?.campuses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="note">Where students find you</label>
            <textarea id="note" name="note" maxLength={500} />
          </div>
          <button className="btn btn-primary" type="submit" style={{ width: "100%" }}>
            Send for approval
          </button>
        </form>
      )}
    </AuthFrame>
  );
}
