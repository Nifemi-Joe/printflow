/**
 * Load check for the hot student and shop read paths and the quote engine.
 * Runs against a live API with demo data (pnpm db:seed) and reports latency
 * percentiles, throughput and errors. It is a smoke-level performance test,
 * not a capacity plan: results depend entirely on the machine and database.
 *
 *   API=http://localhost:4000 DEMO_PASSWORD=… CONCURRENCY=20 DURATION_S=20 node apps/api/scripts/perf.mjs
 *
 * Exits non-zero if any request fails or a p95 exceeds P95_BUDGET_MS (default 500).
 * Run it with RATE_LIMIT_SCALE raised: production limits would (correctly) throttle one client.
 */
const API = process.env.API ?? "http://localhost:4000";
const PASSWORD = process.env.DEMO_PASSWORD;
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 20);
const DURATION_MS = Number(process.env.DURATION_S ?? 20) * 1000;
const BUDGET = Number(process.env.P95_BUDGET_MS ?? 500);
if (!PASSWORD) throw new Error("set DEMO_PASSWORD");

async function login(email) {
  const r = await fetch(`${API}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD, client: "mobile" }) });
  if (!r.ok) throw new Error(`login ${email}: ${r.status}`);
  return (await r.json()).sessionToken;
}
const call = async (token, path, init = {}) => {
  const r = await fetch(`${API}/v1${path}`, { method: init.method ?? "GET", headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) }, body: init.body ? JSON.stringify(init.body) : undefined });
  const body = await r.text();
  if (!r.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${r.status} ${body.slice(0, 160)}`);
  return body ? JSON.parse(body) : null;
};

const student = await login("student@demo.printflow.test");
const me = await call(student, "/auth/me");
const shops = await call(student, `/universities/${me.student.universityId}/shops`);
const shop = shops.items.find((s) => s.acceptingOrders);
const docs = await call(student, "/documents");
const ready = docs.items.find((d) => d.latestVersion.status === "READY");
if (!shop || !ready) throw new Error("needs a seeded shop and at least one READY document for the demo student");

const scenarios = {
  "GET shops with queue estimates": () => call(student, `/universities/${me.student.universityId}/shops`),
  "GET my orders (page of 25)": () => call(student, "/orders?limit=25"),
  "POST quote (server pricing)": () =>
    call(student, "/quotes", { method: "POST", body: { documentVersionId: ready.latestVersion.id, shopId: shop.id, spec: { copies: 3, pageRanges: "1-2", paperSize: "A4", colourMode: "BW", sides: "DOUBLE" } } }),
  "GET price list": () => call(student, `/shops/${shop.id}/price-list`),
};

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
let failed = false;
console.log(`API ${API}, ${CONCURRENCY} concurrent clients, ${DURATION_MS / 1000}s per scenario\n`);
for (const [name, fn] of Object.entries(scenarios)) {
  const lat = [];
  const errors = [];
  const end = Date.now() + DURATION_MS;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (Date.now() < end) {
        const t = performance.now();
        try {
          await fn();
          lat.push(performance.now() - t);
        } catch (e) {
          errors.push(String(e.message ?? e));
        }
      }
    }),
  );
  lat.sort((a, b) => a - b);
  const p95 = pct(lat, 95);
  const ok = errors.length === 0 && p95 <= BUDGET;
  if (!ok) failed = true;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name.padEnd(34)} ${String(lat.length).padStart(6)} req  ${(lat.length / (DURATION_MS / 1000)).toFixed(0).padStart(5)} req/s  ` +
      `p50 ${pct(lat, 50).toFixed(1)} ms  p95 ${p95.toFixed(1)} ms  p99 ${pct(lat, 99).toFixed(1)} ms  errors ${errors.length}`,
  );
  if (errors.length) console.log(`      first error: ${errors[0]}`);
}
console.log(`\np95 budget ${BUDGET} ms`);
process.exit(failed ? 1 : 0);
