"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { StaticJourney } from "./StaticJourney";

const JourneyScene = dynamic(() => import("./JourneyScene"), { ssr: false, loading: () => null });

/**
 * Whether sending someone a WebGL scene is a kindness or an imposition. On a
 * saver-mode or low-memory phone — which is a great many of the phones this is
 * built for — the flat drawing is the better page, not a lesser one.
 */
export function canUse3D(): boolean {
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

/**
 * The spine of the page: a stage that stays put while the steps beside it
 * scroll, and a scene that walks from the student's phone to the shop counter
 * as they do.
 *
 * Scroll position is only ever read, never intercepted — the wheel, the
 * scrollbar, the space bar and a screen reader's own navigation all behave
 * exactly as they would on a page with no scene at all. `children` are the step
 * panels, rendered on the server, and they carry the whole message on their own.
 */
export function Journey({ lead, children, steps }: { lead: ReactNode; children: ReactNode; steps: number }) {
    const container = useRef<HTMLDivElement>(null);
    const stage = useRef<HTMLDivElement>(null);
    const progress = useRef(0);
    const [threeD, setThreeD] = useState(false);
    const [active, setActive] = useState(false);
    const [stageIndex, setStageIndex] = useState(0);

    // Load the scene only once the page is idle, so it never delays the words.
    useEffect(() => {
        if (!canUse3D()) return;
        const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
        const start = () => setThreeD(true);
        if (w.requestIdleCallback) w.requestIdleCallback(start, { timeout: 2500 });
        else setTimeout(start, 1200);
    }, []);

    // Read how far through the pinned section we are, once per frame at most.
    useEffect(() => {
        let frame = 0;
        const measure = () => {
            frame = 0;
            const box = container.current;
            const pinned = stage.current;
            if (!box || !pinned) return;
            const r = box.getBoundingClientRect();
            const travel = r.height - pinned.offsetHeight;
            if (travel <= 0) return;
            const top = parseFloat(getComputedStyle(pinned).top) || 0;
            const p = Math.min(1, Math.max(0, (top - r.top) / travel));
            progress.current = p;
            const i = Math.min(steps - 1, Math.max(0, Math.round(p * (steps - 1))));
            setStageIndex((prev) => (prev === i ? prev : i));
        };
        const onScroll = () => {
            if (!frame) frame = requestAnimationFrame(measure);
        };
        measure();
        window.addEventListener("scroll", onScroll, { passive: true });
        window.addEventListener("resize", onScroll, { passive: true });
        return () => {
            if (frame) cancelAnimationFrame(frame);
            window.removeEventListener("scroll", onScroll);
            window.removeEventListener("resize", onScroll);
        };
    }, [steps]);

    // Draw nothing at all while the stage is off screen.
    useEffect(() => {
        const el = stage.current;
        if (!el || typeof IntersectionObserver === "undefined") return;
        const obs = new IntersectionObserver((entries) => setActive(entries.some((e) => e.isIntersecting)), { rootMargin: "200px" });
        obs.observe(el);
        return () => obs.disconnect();
    }, []);

    return (
        <div className="journey" ref={container} data-stage={stageIndex}>
            {/* The headline comes first in the document, so the stage never stands
          between a reader — or a crawler — and what this page is for. */}
            <div className="journey-lead">{lead}</div>
            <div className="journey-stage" ref={stage} data-mode={threeD ? "3d" : "static"}>
                {threeD ? <JourneyScene progress={progress} active={active} /> : <StaticJourney />}
            </div>
            <ol className="journey-steps">{children}</ol>
        </div>
    );
}