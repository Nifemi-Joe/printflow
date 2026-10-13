"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { Empty, ErrorNotice, PageHead, Skeleton, StatusPill } from "@/components/ui";
import { api, ApiError, toBrowserUrl, uploadFile } from "@/lib/api";
import { relative } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useData } from "@/lib/use-data";

interface Doc {
  id: string;
  title: string;
  createdAt: string;
  latestVersion: { id: string; versionNumber: number; filename: string; status: string; pageCount: number | null; pageSize: string | null; failureReason: string | null; bytes: number; previewPages: number | null };
}

interface UploadItem {
  key: string;
  file: File;
  progress: number;
  state: "uploading" | "done" | "failed";
  error?: string;
  replaceAssetId?: string;
  abort: AbortController;
}

const MAX = 50 * 1024 * 1024;
const OK_TYPES = [".pdf", ".docx"];

export default function DocumentsPage() {
  const { me, refresh } = useSession();
  const { data, error, loading, reload } = useData<{ items: Doc[] }>("/documents", { pollMs: 4000 });
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [drag, setDrag] = useState(false);
  const [preview, setPreview] = useState<{ title: string; urls: string[] } | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const input = useRef<HTMLInputElement>(null);
  const replaceTarget = useRef<string | undefined>(undefined);

  const start = useCallback(
    (file: File, replaceAssetId?: string) => {
      const key = `${file.name}-${Date.now()}-${Math.random()}`;
      const lower = file.name.toLowerCase();
      const abort = new AbortController();
      if (!OK_TYPES.some((t) => lower.endsWith(t))) {
        setUploads((u) => [...u, { key, file, progress: 0, state: "failed", error: "Only PDF and Word (.docx) files can be printed.", abort }]);
        return;
      }
      if (file.size > MAX) {
        setUploads((u) => [...u, { key, file, progress: 0, state: "failed", error: "This file is larger than 50 MB.", abort }]);
        return;
      }
      setUploads((u) => [...u, { key, file, progress: 0, state: "uploading", replaceAssetId, abort }]);
      const set = (patch: Partial<UploadItem>) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, ...patch } : x)));
      uploadFile(replaceAssetId ? `/documents/${replaceAssetId}/versions` : "/documents", file, (p) => set({ progress: p }), abort.signal)
        .then(() => {
          set({ state: "done", progress: 1 });
          void reload();
        })
        .catch((e: unknown) => set({ state: "failed", error: e instanceof ApiError ? e.message : "Upload failed." }));
    },
    [reload],
  );

  const pick = (files: FileList | null) => {
    for (const f of Array.from(files ?? [])) start(f, replaceTarget.current);
    replaceTarget.current = undefined;
  };

  const showPreview = async (d: Doc) => {
    setActionError(null);
    try {
      const n = d.latestVersion.previewPages ?? 0;
      const urls = await Promise.all(Array.from({ length: n }, (_, i) => api<{ url: string }>(`/documents/versions/${d.latestVersion.id}/previews/${i + 1}`).then((r) => r.url)));
      setPreview({ title: d.title, urls: urls.map(toBrowserUrl) });
    } catch (e) {
      setActionError(e);
    }
  };

  return (
    <>
      <PageHead title="Documents">
        <button className="btn btn-primary" onClick={() => input.current?.click()}>
          Upload a document
        </button>
      </PageHead>

      {me && !me.user.emailVerified && (
        <div className="notice notice-warn" role="status">
          <p>Confirm your email address to place orders. We sent a link to {me.user.email}.</p>
          <button
            className="btn btn-quiet btn-small"
            onClick={async () => {
              await api("/auth/verify-email/resend", { method: "POST" }).catch(() => undefined);
              await refresh();
            }}
          >
            Send the link again
          </button>
        </div>
      )}

      <input
        ref={input}
        type="file"
        accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        multiple
        hidden
        onChange={(e) => {
          pick(e.target.files);
          e.target.value = "";
        }}
      />
      <div
        className="empty"
        style={{ borderColor: drag ? "var(--emerald)" : undefined, background: drag ? "var(--emerald-wash)" : undefined, marginBottom: "1.5rem" }}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          pick(e.dataTransfer.files);
        }}
      >
        <h3>Drop PDF or Word files here</h3>
        <p className="muted">Up to 50 MB each. We scan every file, count its pages and prepare a preview.</p>
        <button className="btn btn-quiet" onClick={() => input.current?.click()}>
          Choose files
        </button>
      </div>

      {uploads.length > 0 && (
        <div className="sheet" aria-live="polite" style={{ marginBottom: "1.5rem" }}>
          <h3>Uploads</h3>
          {uploads.map((u) => (
            <div key={u.key} style={{ padding: "0.6rem 0", borderBottom: "1px solid var(--rule)" }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong style={{ wordBreak: "break-all" }}>{u.file.name}</strong>
                <span className="muted">{u.state === "uploading" ? `${Math.round(u.progress * 100)}%` : u.state === "done" ? "Uploaded" : "Failed"}</span>
              </div>
              {u.state === "uploading" && (
                <div className="row" style={{ marginTop: "0.4rem" }}>
                  <div className="progress" style={{ flex: 1 }} role="progressbar" aria-valuenow={Math.round(u.progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={`Uploading ${u.file.name}`}>
                    <span style={{ width: `${u.progress * 100}%` }} />
                  </div>
                  <button className="btn btn-quiet btn-small" onClick={() => u.abort.abort()}>
                    Cancel
                  </button>
                </div>
              )}
              {u.state === "failed" && (
                <div className="row" style={{ marginTop: "0.4rem" }}>
                  <span style={{ color: "var(--red)" }}>{u.error}</span>
                  {u.error !== "Only PDF and Word (.docx) files can be printed." && u.error !== "This file is larger than 50 MB." && (
                    <button
                      className="btn btn-quiet btn-small"
                      onClick={() => {
                        setUploads((list) => list.filter((x) => x.key !== u.key));
                        start(u.file, u.replaceAssetId);
                      }}
                    >
                      Retry
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <ErrorNotice error={error ?? actionError} onRetry={reload} />
      {loading ? (
        <Skeleton lines={4} />
      ) : data && data.items.length === 0 ? (
        <Empty title="No documents yet">Upload lecture notes, assignments or project reports, then choose a shop to print them.</Empty>
      ) : (
        <div className="table-wrap sheet" tabIndex={0} role="region" aria-label="Scrollable table" style={{ padding: 0 }}>
          <table className="stack-sm">
            <thead>
              <tr>
                <th scope="col">Document</th>
                <th scope="col">Status</th>
                <th scope="col" className="num">Pages</th>
                <th scope="col">Uploaded</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data?.items.map((d) => (
                <tr key={d.id}>
                  <td>
                    <strong>{d.title}</strong>
                    <div className="muted">
                      {d.latestVersion.filename}
                      {d.latestVersion.versionNumber > 1 && ` (version ${d.latestVersion.versionNumber})`}
                    </div>
                    {d.latestVersion.failureReason && <div style={{ color: "var(--red)" }}>{d.latestVersion.failureReason}</div>}
                  </td>
                  <td>
                    <StatusPill status={d.latestVersion.status} label={{ PENDING: "Checking", PROCESSING: "Preparing", READY: "Ready to print", REJECTED: "Rejected", FAILED: "Failed" }[d.latestVersion.status]} />
                  </td>
                  <td className="num" data-label="Pages">{d.latestVersion.pageCount ?? "—"}</td>
                  <td data-label="Uploaded">{relative(d.createdAt)}</td>
                  <td>
                    <div className="row" style={{ justifyContent: "flex-end" }}>
                      {d.latestVersion.status === "READY" && (
                        <>
                          <Link className="btn btn-primary btn-small" href={`/student/print?document=${d.latestVersion.id}`}>
                            Print
                          </Link>
                          <button className="btn btn-quiet btn-small" onClick={() => showPreview(d)}>
                            Preview
                          </button>
                        </>
                      )}
                      <button
                        className="btn btn-quiet btn-small"
                        onClick={() => {
                          replaceTarget.current = d.id;
                          input.current?.click();
                        }}
                      >
                        Replace
                      </button>
                      <button
                        className="btn btn-danger btn-small"
                        onClick={async () => {
                          if (!window.confirm(`Delete "${d.title}"? Orders already placed are not affected.`)) return;
                          try {
                            await api(`/documents/${d.id}`, { method: "DELETE" });
                            await reload();
                          } catch (e) {
                            setActionError(e);
                          }
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {preview && (
        <div role="dialog" aria-modal="true" aria-label={`Preview of ${preview.title}`} style={{ position: "fixed", inset: 0, background: "rgba(5,64,45,.55)", zIndex: 60, overflow: "auto", padding: "2rem 1rem" }} onClick={() => setPreview(null)}>
          <div className="sheet" style={{ maxWidth: 720, margin: "0 auto" }} onClick={(e) => e.stopPropagation()}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h2 style={{ margin: 0 }}>{preview.title}</h2>
              <button className="btn btn-quiet btn-small" autoFocus onClick={() => setPreview(null)}>
                Close
              </button>
            </div>
            <p className="muted">First pages, as they will be printed.</p>
            <div className="row" style={{ alignItems: "flex-start" }}>
              {preview.urls.map((u, i) => (
                <img key={u} src={u} alt={`Page ${i + 1}`} style={{ width: 200, border: "1px solid var(--rule)", background: "#fff" }} />
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
