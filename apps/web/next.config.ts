import { PHASE_DEVELOPMENT_SERVER } from "next/constants.js";
import type { NextConfig } from "next";

const API_ORIGIN = process.env.API_ORIGIN ?? "http://localhost:5001";
const isProd = process.env.NODE_ENV === "production";

// The web app proxies /api/* to the API so the session cookie is first-party.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${process.env.NEXT_PUBLIC_STORAGE_ORIGIN ?? ""}`.trim(),
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: "standalone",
  outputFileTracingRoot: new URL("../../", import.meta.url).pathname,
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_ORIGIN}/:path*` }];
  },
  async headers() {
    return [
      // The service worker must never be served stale, or updates would not reach people.
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }, { key: "Service-Worker-Allowed", value: "/" }] },
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          ...(isProd ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }] : []),
        ],
      },
    ];
  },
};

/**
 * `next dev` and `next build` must never share an output directory: a build
 * written while the dev server is watching leaves it serving a mix of the two,
 * which shows up as healthy components resolving to `undefined` on pages that
 * are perfectly fine.
 *
 * Which directory is chosen by the COMMAND, not by NODE_ENV. Keying it on
 * NODE_ENV was a real bug: `next build` keeps whatever NODE_ENV it is given, and
 * docs/TESTING.md tells you to export NODE_ENV=development for the local stack.
 * The build then wrote to .next-dev while `next start` — which forces
 * NODE_ENV=production — read .next, so the server quietly served an older build:
 * new routes 404ing and stale CSS on the pages that did load.
 */
export default (phase: string): NextConfig => ({
  ...nextConfig,
  distDir: phase === PHASE_DEVELOPMENT_SERVER ? ".next-dev" : ".next",
});