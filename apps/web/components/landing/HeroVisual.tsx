"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

const PrinterScene = dynamic(() => import("./PrinterScene"), { ssr: false, loading: () => null });

/** Same scene as the 3D view, drawn flat. Shown first, and kept when 3D is unsuitable. */
export function StaticPrinter() {
  return (
    <svg viewBox="0 0 480 400" role="img" aria-labelledby="static-printer-title" style={{ width: "100%", height: "auto" }}>
      <title id="static-printer-title">A printer feeding out a sheet showing a job ticket with a total of ₦476.30 and a pickup code</title>
      <ellipse cx="250" cy="352" rx="200" ry="22" fill="#05402d" opacity="0.08" />
      <rect x="70" y="200" width="340" height="120" rx="14" fill="#2b3137" />
      <rect x="86" y="182" width="300" height="34" rx="8" fill="#3a4148" />
      <rect x="120" y="226" width="240" height="10" rx="4" fill="#14181b" />
      <circle cx="372" cy="246" r="6" fill="#0a7a55" />
      <g transform="translate(150 70) rotate(-4)">
        <rect width="190" height="190" rx="3" fill="#fff" stroke="#d6dbd5" />
        <text x="18" y="34" fontFamily="var(--font-display)" fontWeight="700" fontSize="17" fill="#05402d">CSC 201 notes</text>
        <text x="18" y="56" fontFamily="var(--font-body)" fontSize="11" fill="#5a6168">24 pages, A4, black &amp; white</text>
        <line x1="18" x2="172" y1="74" y2="74" stroke="#d6dbd5" strokeDasharray="4 4" />
        <text x="18" y="94" fontFamily="var(--font-body)" fontSize="11" fill="#24292e">12 sheets</text>
        <text x="172" y="94" textAnchor="end" fontFamily="var(--font-body)" fontSize="11" fill="#24292e">₦420.00</text>
        <text x="18" y="114" fontFamily="var(--font-body)" fontSize="11" fill="#24292e">Service fee</text>
        <text x="172" y="114" textAnchor="end" fontFamily="var(--font-body)" fontSize="11" fill="#24292e">₦56.30</text>
        <text x="18" y="142" fontFamily="var(--font-display)" fontWeight="700" fontSize="15" fill="#05402d">Total</text>
        <text x="172" y="142" textAnchor="end" fontFamily="var(--font-display)" fontWeight="700" fontSize="15" fill="#05402d">₦476.30</text>
        <rect x="18" y="154" width="154" height="24" rx="2" fill="#0a7a55" />
        <text x="95" y="171" textAnchor="middle" fontFamily="var(--font-display)" fontWeight="700" fontSize="12" fill="#fff">Pickup 482 913</text>
      </g>
      {[0, 1, 2].map((i) => (
        <rect key={i} x={20 + i * 2} y={300 - i * 4} width="110" height="40" rx="2" fill="#fdfdfb" stroke="#d6dbd5" transform={`rotate(${i % 2 ? 2 : -2} 75 320)`} />
      ))}
    </svg>
  );
}

function canUse3D(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  const nav = navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string }; deviceMemory?: number };
  if (nav.connection?.saveData) return false;
  if (nav.connection?.effectiveType && /(^|-)2g$/.test(nav.connection.effectiveType)) return false;
  if (nav.deviceMemory !== undefined && nav.deviceMemory < 2) return false;
  try {
    const c = document.createElement("canvas");
    return Boolean(c.getContext("webgl2") ?? c.getContext("webgl"));
  } catch {
    return false;
  }
}

export function HeroVisual() {
  const [threeD, setThreeD] = useState(false);

  useEffect(() => {
    if (!canUse3D()) return;
    // Load the 3D scene only after the page is idle, so it never delays content.
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
    const start = () => setThreeD(true);
    if (w.requestIdleCallback) w.requestIdleCallback(start, { timeout: 2500 });
    else setTimeout(start, 1200);
  }, []);

  return (
    <div className="hero-visual" data-mode={threeD ? "3d" : "static"}>
      {threeD ? <PrinterScene /> : <StaticPrinter />}
    </div>
  );
}
