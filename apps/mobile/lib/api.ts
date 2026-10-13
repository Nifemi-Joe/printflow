import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

/**
 * Mobile clients authenticate with a bearer token (login with client=mobile),
 * kept in the device's secure storage. No cookies, so no CSRF header is needed.
 */
export const API_URL: string =
  process.env.EXPO_PUBLIC_API_URL ?? (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl ?? "http://localhost:4000";

const TOKEN_KEY = "pf_session_token";
let token: string | null = null;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function readToken(): Promise<string | null> {
  if (Platform.OS === "web") return token;
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export async function loadToken(): Promise<string | null> {
  token = await readToken();
  return token;
}

export async function saveToken(t: string | null): Promise<void> {
  token = t;
  if (Platform.OS === "web") return;
  if (t) await SecureStore.setItemAsync(TOKEN_KEY, t, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  else await SecureStore.deleteItemAsync(TOKEN_KEY);
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/v1${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ApiError(0, "OFFLINE", "You appear to be offline. Check your connection and try again.");
  }
  if (res.status === 204) return null as T;
  const body = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
  if (!res.ok) {
    if (res.status === 401) await saveToken(null);
    throw new ApiError(res.status, body?.error?.code ?? "ERROR", body?.error?.message ?? `Request failed (${res.status})`);
  }
  return body as T;
}

/** Streams a picked file to the API with upload progress (XHR supports progress in React Native). */
export async function uploadDocument(fileUri: string, name: string, mime: string, onProgress: (f: number) => void, path = "/documents"): Promise<{ assetId: string; versionId: string }> {
  const blob = await (await fetch(fileUri)).blob();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_URL}/v1${path}`);
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("Content-Type", mime || "application/octet-stream");
    xhr.setRequestHeader("X-Filename", encodeURIComponent(name));
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
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
    xhr.onerror = () => reject(new ApiError(0, "OFFLINE", "The connection dropped during the upload."));
    xhr.send(blob);
  });
}

export function idempotencyKey(): string {
  const rnd = () => Math.random().toString(36).slice(2, 10);
  return `mobile-${Date.now().toString(36)}-${rnd()}${rnd()}`;
}

export function errorMessage(e: unknown): string {
  const m = e instanceof ApiError ? e.message : "Something went wrong.";
  const s = m.charAt(0).toUpperCase() + m.slice(1);
  return s.endsWith(".") ? s : `${s}.`;
}
