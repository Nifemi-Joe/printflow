/**
 * What a provider has told us about a printer, and what it costs them not to.
 *
 * The governing rule, which the rest of the system must not quietly undo: a
 * missing detail is never a reason to stop someone printing. A student who has
 * just carried a printer into their hostel room can register it with a name and
 * nothing else and take orders the same hour. Everything here exists to tell
 * them, in their own interest, what each blank costs — never to withhold the
 * product until a form is full.
 */

export const PRINTER_PAPER_SIZES = ["A4", "A3", "A5", "LETTER", "LEGAL"] as const;
export type PrinterPaperSize = (typeof PRINTER_PAPER_SIZES)[number];

export interface PrinterDetails {
    label: string;
    serialNumber: string | null;
    make: string | null;
    model: string | null;
    /** null means "not told us"; false means "told us it cannot". */
    colour: boolean | null;
    duplex: boolean | null;
    paperSizes: readonly string[] | null;
    notes: string | null;
}

export interface PrinterGap {
    field: "serialNumber" | "make" | "model" | "colour" | "duplex" | "paperSizes";
    label: string;
    /** Said to the provider, in terms of what it costs them — not what we want. */
    cost: string;
}

/**
 * The details this printer is missing, worst first. An empty list means there is
 * nothing more we would like to know; it does not mean anything was required.
 */
export function printerGaps(d: PrinterDetails): PrinterGap[] {
    const gaps: PrinterGap[] = [];
    if (!d.serialNumber?.trim()) {
        gaps.push({
            field: "serialNumber",
            label: "Serial or ID number",
            cost: "If a student ever disputes a job, this is how your university tells your printer apart from anyone else's. Without it, a dispute is your word against theirs.",
        });
    }
    if (d.paperSizes === null || d.paperSizes.length === 0) {
        gaps.push({
            field: "paperSizes",
            label: "Paper sizes",
            cost: "Students can send you A3 and legal jobs you may not be able to print, and you will have to turn them down after they have paid.",
        });
    }
    if (d.colour === null) {
        gaps.push({
            field: "colour",
            label: "Colour or black and white",
            cost: "Colour jobs will keep reaching you even if you can only print black and white.",
        });
    }
    if (d.duplex === null) {
        gaps.push({
            field: "duplex",
            label: "Double-sided printing",
            cost: "Double-sided jobs will keep reaching you even if you can only print one side at a time.",
        });
    }
    if (!d.make?.trim() || !d.model?.trim()) {
        gaps.push({
            field: d.make?.trim() ? "model" : "make",
            label: "Make and model",
            cost: "Students are more likely to choose a shop whose printer they recognise, and it helps your university help you when something goes wrong.",
        });
    }
    return gaps;
}

/**
 * One line for the provider. Never an error, never a warning in the sense of
 * something being wrong: they have done nothing wrong by leaving a field blank.
 */
export function printerGapSummary(gaps: readonly PrinterGap[]): string | null {
    if (gaps.length === 0) return null;
    const names = gaps.map((g) => g.label.toLowerCase());
    const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]!}`;
    return `We still don't know the ${list} for this printer. You can take orders without it — this is only so students see the right thing.`;
}

/** True when a provider has answered everything we ask about a printer. */
export function printerComplete(d: PrinterDetails): boolean {
    return printerGaps(d).length === 0;
}

/**
 * What a student would see about a printer's abilities. Anything not told to us
 * is reported as unknown rather than guessed in either direction: claiming a
 * printer does colour when nobody said so sends people's money the wrong way,
 * and claiming it does not would cost the provider work they could have done.
 */
export function printerAbilities(d: PrinterDetails): { colour: boolean | null; duplex: boolean | null; paperSizes: readonly string[] | null } {
    return { colour: d.colour, duplex: d.duplex, paperSizes: d.paperSizes && d.paperSizes.length > 0 ? d.paperSizes : null };
}