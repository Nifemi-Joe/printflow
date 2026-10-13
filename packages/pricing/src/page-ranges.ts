export class PageRangeError extends Error {
  override readonly name = "PageRangeError";
}

const MAX_RANGE_INPUT = 500;

/**
 * Parses a page range string like "1-3, 5, 9-12" against a document's page count.
 * Returns sorted, unique 1-based page numbers. Rejects overlaps, reversed ranges,
 * out-of-bounds pages and anything that is not digits, commas, hyphens and spaces.
 */
export function parsePageRanges(input: string | undefined, documentPageCount: number): number[] {
  if (!Number.isSafeInteger(documentPageCount) || documentPageCount < 1) {
    throw new PageRangeError(`document page count must be a positive integer, got ${documentPageCount}`);
  }
  const trimmed = (input ?? "").trim();
  if (trimmed === "") {
    return Array.from({ length: documentPageCount }, (_, i) => i + 1);
  }
  if (trimmed.length > MAX_RANGE_INPUT) {
    throw new PageRangeError("page range is too long");
  }
  if (!/^[\d\s,-]+$/.test(trimmed)) {
    throw new PageRangeError("page range may only contain digits, commas, hyphens and spaces");
  }

  const seen = new Set<number>();
  for (const rawPart of trimmed.split(",")) {
    const part = rawPart.trim();
    if (part === "") throw new PageRangeError("page range contains an empty segment");
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!match) throw new PageRangeError(`invalid page range segment "${part}"`);
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (start < 1 || end < 1) throw new PageRangeError("pages are numbered from 1");
    if (end < start) throw new PageRangeError(`range "${part}" is reversed`);
    if (end > documentPageCount) {
      throw new PageRangeError(`page ${end} is beyond the document's ${documentPageCount} pages`);
    }
    for (let p = start; p <= end; p++) {
      if (seen.has(p)) throw new PageRangeError(`page ${p} is selected more than once`);
      seen.add(p);
    }
  }
  return [...seen].sort((a, b) => a - b);
}
