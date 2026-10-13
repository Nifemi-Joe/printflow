"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AuthFrame } from "@/components/AuthFrame";
import { ErrorNotice, Field } from "@/components/ui";
import { api, ApiError, setCsrf } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useData } from "@/lib/use-data";

interface Uni {
  id: string;
  name: string;
}
interface UniDetail {
  campuses: Array<{ id: string; name: string; departments: Array<{ id: string; name: string }> }>;
}

export default function RegisterPage() {
  const router = useRouter();
  const { refresh } = useSession();
  const unis = useData<{ items: Uni[] }>("/universities");
  const [uni, setUni] = useState("");
  const [campus, setCampus] = useState("");
  const detail = useData<UniDetail>(uni ? `/universities/${uni}` : null);
  const [error, setError] = useState<unknown>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const departments = detail.data?.campuses.find((c) => c.id === campus)?.departments ?? [];

  return (
    <AuthFrame title="Create your student account" footer={<p>Already have an account? <Link href="/login">Sign in</Link></p>}>
      {unis.data && unis.data.items.length === 0 && <div className="notice notice-warn"><p>No universities are open for registration yet.</p></div>}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          setBusy(true);
          setError(null);
          setFields({});
          try {
            const res = await api<{ csrfToken: string }>("/auth/register", {
              method: "POST",
              body: {
                fullName: f.get("fullName"),
                email: f.get("email"),
                password: f.get("password"),
                universityId: uni,
                campusId: campus,
                ...(f.get("departmentId") ? { departmentId: f.get("departmentId") } : {}),
                ...(f.get("matricNumber") ? { matricNumber: f.get("matricNumber") } : {}),
                ...(f.get("phone") ? { phone: f.get("phone") } : {}),
              },
            });
            setCsrf(res.csrfToken);
            await refresh();
            router.replace("/verify?welcome=1");
          } catch (err) {
            setError(err);
            if (err instanceof ApiError) setFields(err.fieldErrors());
            setBusy(false);
          }
        }}
        noValidate={false}
      >
        <ErrorNotice error={error} />
        <Field id="fullName" label="Full name" error={fields.fullName}>
          <input id="fullName" name="fullName" autoComplete="name" required minLength={2} />
        </Field>
        <Field id="email" label="Email" error={fields.email} hint="We send a confirmation link here.">
          <input id="email" name="email" type="email" autoComplete="email" required />
        </Field>
        <Field id="password" label="Password" error={fields.password} hint="At least 10 characters.">
          <input id="password" name="password" type="password" autoComplete="new-password" required minLength={10} />
        </Field>
        <Field id="university" label="University" error={fields.universityId}>
          <select id="university" required value={uni} onChange={(e) => (setUni(e.target.value), setCampus(""))}>
            <option value="">Choose your university</option>
            {unis.data?.items.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </Field>
        <Field id="campus" label="Campus" error={fields.campusId}>
          <select id="campus" required value={campus} disabled={!detail.data} onChange={(e) => setCampus(e.target.value)}>
            <option value="">{uni ? "Choose your campus" : "Choose a university first"}</option>
            {detail.data?.campuses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        {departments.length > 0 && (
          <Field id="departmentId" label="Department (optional)">
            <select id="departmentId" name="departmentId">
              <option value="">Not listed</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field id="matricNumber" label="Matric number (optional)" error={fields.matricNumber}>
          <input id="matricNumber" name="matricNumber" />
        </Field>
        <Field id="phone" label="Phone number (recommended)" error={fields.phone} hint="We text a code to confirm it, and tell you when your prints are ready. e.g. 0801 234 5678">
          <input id="phone" name="phone" type="tel" inputMode="tel" autoComplete="tel" />
        </Field>
        <button className="btn btn-primary" type="submit" disabled={busy || !campus} style={{ width: "100%" }}>
          {busy ? "Creating your account…" : "Create account"}
        </button>
      </form>
    </AuthFrame>
  );
}
