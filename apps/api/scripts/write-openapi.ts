import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOpenApi, listRoutes, ROUTE_DOCS } from "../src/openapi.js";

const missing = listRoutes().filter((r) => !ROUTE_DOCS[`${r.method} ${r.path}`]);
if (missing.length) {
  console.error(`Undocumented routes:\n${missing.map((m) => `  ${m.method} ${m.path}`).join("\n")}`);
  process.exit(1);
}
const out = resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs/openapi.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(buildOpenApi(), null, 2) + "\n");
console.warn(`wrote ${out}`);
