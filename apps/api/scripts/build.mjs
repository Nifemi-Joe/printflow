// Bundles the API into dist/main.js. Workspace packages (imported by relative
// path) are bundled; npm dependencies stay external and are installed in the image.
import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  packages: "external",
  sourcemap: true,
  tsconfig: "tsconfig.json",
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: "info",
};

await build({
  ...common,
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
});

// The migration runner ships in the API image (docker compose "migrate" service).
// Set MIGRATIONS_DIR to wherever db/migrations is copied.
await build({
  ...common,
  entryPoints: ["../../db/scripts/migrate.ts"],
  outfile: "dist/migrate.js",
  sourcemap: false,
});
