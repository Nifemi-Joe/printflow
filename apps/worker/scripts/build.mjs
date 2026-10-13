// Bundles the API into dist/main.js. Workspace packages (imported by relative
// path) are bundled; npm dependencies stay external and are installed in the image.
import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  packages: "external",
  sourcemap: true,
  tsconfig: "tsconfig.json",
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: "info",
});
