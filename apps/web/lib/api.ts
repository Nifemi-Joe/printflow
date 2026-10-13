/**
 * Browser client for the PrintFlow API. Requests go to /api/* on the web origin
 * (Next rewrites them to the API), so the session cookie is first-party.
 */
export const API_BASE = "/api/v1";

export class ApiError extends Error {
  constructor(
      readonly status: number,
      readonly code: string,
      message: string,
      readonly details?: unknown,
  ) {
    super(message);
  }
  /** Field-level validation messages keyed by field path. */
  fieldErrors(): Record<string, string> {
    if (!Array.isArray(this.details)) return {};
    return Object.fromEntries((this.details as Array<{ path: string; message: string }>).map((d) => [d.path, d.message]));
  }
}

let csrfToken = "";
export function setCsrf(token: string) {
  csrfToken = token;
}

/** Fired when the API says the session is gone (expired, revoked, signed out elsewhere). */
export const SESSION_LOST_EVENT = "printflow:session-lost";

async function parse(res: Response) {
  if (res.status === 204) return null;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const e = body?.error;
    if (res.status === 401 && typeof window !== "undefined") window.dispatchEvent(new Event(SESSION_LOST_EVENT));
    throw new ApiError(res.status, e?.code ?? "NETWORK", e?.message ?? `Request failed (${res.status})`, e?.details);
  }
  return body;
}

type ApiInit = { method?: string; body?: unknown; headers?: Record<string, string> };

async function send(path: string, method: string, init: ApiInit): Promise<Response> {
  try {
    return await fetch(`${API_BASE}${path}`, {
      method,
      credentials: "include",
      headers: {
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(method !== "GET" ? { "X-CSRF-Token": csrfToken } : {}),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ApiError(0, "OFFLINE", "You appear to be offline. Check your connection and try again.");
  }
}

/**
 * Fetches the current session's CSRF token. The page's copy goes stale when the
 * session changes in another tab or the API restarts with a new secret.
 */
export async function refreshCsrf(): Promise<boolean> {
  const res = await fetch(`${API_BASE}/auth/session`, { credentials: "include" }).catch(() => null);
  const body = (await res?.json().catch(() => null)) as { authenticated?: boolean; csrfToken?: string } | null;
  if (body?.authenticated && body.csrfToken) {
    csrfToken = body.csrfToken;
    return true;
  }
  csrfToken = "";
  return false;
}

async function isCsrfFailure(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  const body = (await res.clone().json().catch(() => null)) as { error?: { code?: string } } | null;
  return body?.error?.code === "CSRF_FAILED";
}

export async function api<T = unknown>(path: string, init: ApiInit = {}): Promise<T> {
  const method = init.method ?? (init.body === undefined ? "GET" : "POST");
  let res = await send(path, method, init);
  // One retry with a fresh token, so an old tab or an API restart does not strand people.
  if (method !== "GET" && (await isCsrfFailure(res))) {
    await refreshCsrf();
    res = await send(path, method, init);
  }
  return (await parse(res)) as T;
}

/** Upload with progress (fetch cannot report upload progress); retried once on a stale CSRF token. */
export async function uploadFile(path: string, file: File, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<{ assetId: string; versionId: string; versionNumber: number }> {
  try {
    return await uploadOnce(path, file, onProgress, signal);
  } catch (e) {
    if (!(e instanceof ApiError) || e.code !== "CSRF_FAILED") throw e;
    await refreshCsrf();
    onProgress(0);
    return uploadOnce(path, file, onProgress, signal);
  }
}

function uploadOnce(path: string, file: File, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<{ assetId: string; versionId: string; versionNumber: number }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}${path}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("X-CSRF-Token", csrfToken);
    xhr.setRequestHeader("X-Filename", encodeURIComponent(file.name));
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: { error?: { code: string; message: string } } | null = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as never);
      else reject(new ApiError(xhr.status, body?.error?.code ?? "UPLOAD_FAILED", body?.error?.message ?? "The upload failed."));
    };
    xhr.onerror = () => reject(new ApiError(0, "OFFLINE", "The connection dropped during the upload. Try again."));
    xhr.onabort = () => reject(new ApiError(0, "ABORTED", "Upload cancelled."));
    signal?.addEventListener("abort", () => xhr.abort());
    xhr.send(file);
  });
}

export function newIdempotencyKey(): string {
  return `web-${crypto.randomUUID()}`;
}

/**
 * Signed links from the LOCAL storage driver point at the API's /v1/files route;
 * route those through this origin's /api proxy. S3 links are used as they are.
 */
export function toBrowserUrl(url: string): string {
  const m = /\/v1\/files\/([\w.-]+)$/.exec(url);
  return m ? `${API_BASE}/files/${m[1]}` : url;
}
