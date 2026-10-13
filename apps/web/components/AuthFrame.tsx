import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "./ui";

export function AuthFrame({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <main id="main" style={{ minHeight: "100vh", display: "grid", placeItems: "start center", padding: "3rem 1rem" }}>
      <div style={{ width: "min(440px, 100%)" }}>
        <Link href="/" className="brand" style={{ marginBottom: "1.5rem" }}>
          <Logo /> PrintFlow
        </Link>
        <div className="sheet">
          <h1 style={{ fontSize: "var(--t-2xl)" }}>{title}</h1>
          {children}
        </div>
        {footer && <div style={{ marginTop: "1.25rem" }}>{footer}</div>}
      </div>
    </main>
  );
}
