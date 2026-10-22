/**
 * Runs public/sw.js in a simulated service-worker global with a scripted network,
 * so offline behaviour can be tested deterministically.
 */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { beforeEach, describe, expect, it } from "vitest";

const SRC = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const ORIGIN = "https://printflow.example";
/** Read from the worker itself: bumping its version is a deployment act, not a test change. */
const VERSION = /const VERSION = "([^"]+)"/.exec(SRC)![1];
const PAGES = `${VERSION}-pages`;
const STATIC = `${VERSION}-static`;

class FakeCache {
  store = new Map<string, Response>();
  async match(req: Request | string) {
    const r = this.store.get(typeof req === "string" ? new URL(req, ORIGIN).toString() : req.url);
    return r ? r.clone() : undefined;
  }
  async put(req: Request | string, res: Response) {
    this.store.set(typeof req === "string" ? new URL(req, ORIGIN).toString() : req.url, res);
  }
  async addAll(urls: string[]) {
    for (const u of urls) await this.put(u, await net(new Request(new URL(u, ORIGIN))));
  }
  async keys() {
    return [...this.store.keys()].map((u) => new Request(u));
  }
}

let online = true;
let hits: string[] = [];
async function net(req: Request): Promise<Response> {
  hits.push(new URL(req.url).pathname + new URL(req.url).search);
  if (!online) throw new TypeError("Failed to fetch");
  const path = new URL(req.url).pathname;
  const type = path.startsWith("/_next/") ? "application/javascript" : path.startsWith("/icons/") ? "image/png" : path.startsWith("/api/") ? "application/json" : "text/html; charset=utf-8";
  const res = new Response(`body of ${path}`, { status: 200, headers: { "content-type": type } });
  Object.defineProperty(res, "type", { value: "basic" });
  return res;
}

function boot() {
  const caches = new Map<string, FakeCache>();
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  const self = {
    location: { origin: ORIGIN },
    clients: { claim: async () => undefined },
    skipWaiting: () => undefined,
    addEventListener: (t: string, fn: (e: unknown) => void) => ((listeners[t] ??= []).push(fn), undefined),
  };
  const cacheStorage = {
    open: async (n: string) => (caches.has(n) ? caches.get(n)! : (caches.set(n, new FakeCache()), caches.get(n)!)),
    keys: async () => [...caches.keys()],
    delete: async (n: string) => caches.delete(n),
  };
  runInNewContext(SRC, { self, caches: cacheStorage, fetch: net, URL, Response, Request, console });
  const fire = async (type: string, e: Record<string, unknown> = {}) => {
    const waits: Array<Promise<unknown>> = [];
    let responded: Promise<Response> | null = null;
    for (const fn of listeners[type] ?? []) fn({ ...e, waitUntil: (p: Promise<unknown>) => waits.push(p), respondWith: (p: Promise<Response>) => (responded = p) });
    await Promise.all(waits);
    return responded as Promise<Response> | null;
  };
  const get = (path: string, mode: RequestMode = "cors") => {
    const request = new Request(new URL(path, ORIGIN), { mode: mode === "navigate" ? "same-origin" : mode });
    Object.defineProperty(request, "mode", { value: mode });
    return fire("fetch", { request });
  };
  return { caches, fire, get };
}

beforeEach(() => {
  online = true;
  hits = [];
});

describe("service worker", () => {
  it("precaches the offline page on install and clears old versions on activate", async () => {
    const sw = boot();
    await sw.fire("install");
    sw.caches.set("pf-v0-pages", new FakeCache());
    await sw.fire("activate");
    expect([...sw.caches.keys()].sort()).toEqual([PAGES, STATIC].sort());
    expect(await sw.caches.get(PAGES)!.match("/offline")).toBeTruthy();
  });

  it("never handles the API, so it is always fresh and never cached", async () => {
    const sw = boot();
    await sw.fire("install");
    expect(await sw.get("/api/v1/orders")).toBeNull();
    for (const c of sw.caches.values()) expect((await c.keys()).some((r) => r.url.includes("/api/"))).toBe(false);
  });

  it("serves hashed build assets from cache after the first load", async () => {
    const sw = boot();
    await sw.fire("install");
    await (await sw.get("/_next/static/chunks/app.js"))!;
    online = false;
    const r = await (await sw.get("/_next/static/chunks/app.js"))!;
    expect(await r.text()).toBe("body of /_next/static/chunks/app.js");
  });

  it("pages: network first; offline falls back to the last copy, else the offline page", async () => {
    const sw = boot();
    await sw.fire("install");
    const first = await (await sw.get("/student/orders", "navigate"))!;
    expect(await first.text()).toBe("body of /student/orders");
    online = false;
    expect(await (await (await sw.get("/student/orders", "navigate"))!).text()).toBe("body of /student/orders");
    expect(await (await (await sw.get("/privacy", "navigate"))!).text()).toBe("body of /offline");
  });

  it("never stores query strings (one-time tokens) in cache keys", async () => {
    const sw = boot();
    await sw.fire("install");
    await (await sw.get("/verify-email?token=secret-one-time-token", "navigate"))!;
    const keys = (await sw.caches.get(PAGES)!.keys()).map((r) => r.url);
    expect(keys).toContain(`${ORIGIN}/verify-email`);
    expect(keys.some((k) => k.includes("secret-one-time-token"))).toBe(false);
  });

  it("keeps the logo offline, so the loader and the offline page still carry the brand", async () => {
    const sw = boot();
    await sw.fire("install");
    // Precached at install: nothing has to be online for the first offline paint.
    expect(await sw.caches.get(STATIC)!.match("/brand/mark-128.png")).toBeTruthy();
    // And served from the cache once seen, like the other static assets.
    await (await sw.get("/brand/mark-512.png"))!;
    online = false;
    const r = await (await sw.get("/brand/mark-512.png"))!;
    expect(await r.text()).toBe("body of /brand/mark-512.png");
  });

  it("ignores other origins and non-GET requests", async () => {
    const sw = boot();
    expect(await sw.fire("fetch", { request: new Request("https://api.paystack.co/x") })).toBeNull();
    expect(await sw.fire("fetch", { request: new Request(`${ORIGIN}/student/print`, { method: "POST" }) })).toBeNull();
  });
});