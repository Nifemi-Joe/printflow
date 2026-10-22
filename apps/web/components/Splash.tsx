import { Logo } from "./ui";

/**
 * The waiting screen. It exists because the alternative — a blank page, or grey
 * skeleton bars where a whole app is about to appear — tells a student nothing
 * about whether anything is happening, and on a slow campus connection that wait
 * can be several seconds.
 *
 * The three squares echo the ones trailing off the mark, lit in turn: a progress
 * cue drawn from the logo rather than a generic spinner. Nothing moves when the
 * person has asked for reduced motion; the squares simply sit there, lit.
 *
 * `full` covers the viewport (first paint, route changes). Without it the loader
 * centres inside whatever region it is placed in, so the signed-in shell can keep
 * its navigation on screen while the session is checked.
 */
export function BrandLoader({ label = "Loading PrintFlow", full = false }: { label?: string; full?: boolean }) {
    return (
        <div className={full ? "splash splash-full" : "splash"} role="status" aria-live="polite">
            <div className="splash-inner">
                <Logo size={96} />
                <p className="splash-word">PrintFlow</p>
                <p className="splash-label">{label}</p>
                <div className="splash-dots" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                </div>
            </div>
        </div>
    );
}