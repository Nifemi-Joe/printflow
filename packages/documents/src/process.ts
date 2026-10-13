import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { assertSafeDocx, DocumentRejectedError, MAX_PAGES, readHead, readZipCentralDirectory, sniffHead, type DetectedType } from "./sniff.js";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs an external tool without a shell, in its own process group, with a hard
 * timeout that kills the whole group (LibreOffice forks helpers).
 */
export function runCommand(cmd: string, args: readonly string[], opts: { timeoutMs: number; cwd?: string; env?: NodeJS.ProcessEnv }): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < 64_000) stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < 64_000) stderr += d.toString();
    });
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      reject(new DocumentRejectedError(`${cmd} timed out after ${opts.timeoutMs} ms`, "PROCESSING_TIMEOUT"));
    }, opts.timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}

export interface PdfInfo {
  pageCount: number;
  pageSize: "A4" | "A3" | "A5" | "LETTER" | "LEGAL" | "OTHER";
}

const SIZES: Array<[PdfInfo["pageSize"], number, number]> = [
  ["A4", 595.28, 841.89],
  ["A3", 841.89, 1190.55],
  ["A5", 419.53, 595.28],
  ["LETTER", 612, 792],
  ["LEGAL", 612, 1008],
];

export function classifyPageSize(width: number, height: number): PdfInfo["pageSize"] {
  const [w, h] = width < height ? [width, height] : [height, width];
  for (const [name, sw, sh] of SIZES) {
    if (Math.abs(w - sw) <= 6 && Math.abs(h - sh) <= 6) return name;
  }
  return "OTHER";
}

export async function inspectPdf(path: string): Promise<PdfInfo> {
  const bytes = await readFile(path);
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false });
  } catch (e) {
    const msg = (e as Error).message;
    if (/encrypt/i.test(msg)) throw new DocumentRejectedError("password-protected PDFs cannot be printed", "ENCRYPTED");
    throw new DocumentRejectedError("the PDF could not be read; it may be damaged", "BAD_PDF");
  }
  const pageCount = doc.getPageCount();
  if (pageCount < 1) throw new DocumentRejectedError("the document has no pages", "EMPTY");
  if (pageCount > MAX_PAGES) throw new DocumentRejectedError(`documents are limited to ${MAX_PAGES} pages`, "TOO_MANY_PAGES");
  const first = doc.getPage(0).getSize();
  return { pageCount, pageSize: classifyPageSize(first.width, first.height) };
}

export interface ProcessingTools {
  soffice: string;
  qpdf: string;
  pdftoppm: string;
  timeoutMs: number;
}

export const DEFAULT_TOOLS: ProcessingTools = { soffice: "soffice", qpdf: "qpdf", pdftoppm: "pdftoppm", timeoutMs: 120_000 };

/**
 * Converts a DOCX to PDF with LibreOffice in an isolated, throwaway profile.
 * Run the worker container without network egress and as an unprivileged user.
 */
export async function convertDocxToPdf(input: string, outDir: string, tools: ProcessingTools = DEFAULT_TOOLS): Promise<string> {
  const profile = await mkdtemp(join(tmpdir(), "pf-lo-profile-"));
  try {
    const res = await runCommand(
      tools.soffice,
      ["--headless", "--norestore", "--nolockcheck", "--nodefault", `-env:UserInstallation=file://${profile}`, "--convert-to", "pdf", "--outdir", outDir, input],
      { timeoutMs: tools.timeoutMs, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: profile, LANG: "C.UTF-8" } },
    );
    const produced = (await readdir(outDir)).find((f) => f.endsWith(".pdf"));
    if (res.code !== 0 || !produced) throw new DocumentRejectedError("the Word document could not be converted to PDF", "CONVERSION_FAILED");
    return join(outDir, produced);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

/**
 * Rewrites the PDF through qpdf: validates structure, decompresses nothing, drops
 * incremental-update cruft and linearises. Damaged or encrypted files fail here.
 */
export async function normalisePdf(input: string, output: string, tools: ProcessingTools = DEFAULT_TOOLS): Promise<void> {
  const res = await runCommand(tools.qpdf, ["--linearize", "--object-streams=generate", input, output], { timeoutMs: tools.timeoutMs });
  // qpdf exit code 3 = warnings but output written.
  if (res.code !== 0 && res.code !== 3) {
    if (/password|encrypt/i.test(res.stderr)) throw new DocumentRejectedError("password-protected PDFs cannot be printed", "ENCRYPTED");
    throw new DocumentRejectedError("the PDF is damaged and could not be prepared for printing", "BAD_PDF");
  }
}

/** Renders the first N pages as small PNG previews. Returns file paths in page order. */
export async function renderPreviews(pdf: string, outDir: string, pages: number, tools: ProcessingTools = DEFAULT_TOOLS): Promise<string[]> {
  const res = await runCommand(tools.pdftoppm, ["-png", "-r", "48", "-f", "1", "-l", String(pages), pdf, join(outDir, "p")], { timeoutMs: tools.timeoutMs });
  if (res.code !== 0) return [];
  const files = (await readdir(outDir)).filter((f) => /^p-\d+\.png$/.test(f));
  return files.sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0])).map((f) => join(outDir, f));
}

export interface PreparedDocument {
  detectedType: DetectedType;
  printPdfPath: string;
  pageCount: number;
  pageSize: PdfInfo["pageSize"];
  previewPaths: string[];
}

/** Full pipeline from an untrusted upload to a print-ready PDF and previews. */
export async function prepareDocument(input: string, workDir: string, tools: ProcessingTools = DEFAULT_TOOLS): Promise<PreparedDocument> {
  const { size } = await stat(input);
  if (size === 0) throw new DocumentRejectedError("the file is empty", "EMPTY");
  const kind = sniffHead(await readHead(input));
  let sourcePdf: string;
  let detectedType: DetectedType;
  if (kind === "PDF") {
    detectedType = "PDF";
    sourcePdf = input;
  } else if (kind === "ZIP") {
    assertSafeDocx(await readZipCentralDirectory(input));
    detectedType = "DOCX";
    const convDir = await mkdtemp(join(workDir, "conv-"));
    // LibreOffice picks the filter from the extension; give it one we control.
    const named = join(convDir, "document.docx");
    await runCommand("cp", [input, named], { timeoutMs: 30_000 });
    sourcePdf = await convertDocxToPdf(named, convDir, tools);
  } else {
    throw new DocumentRejectedError("only PDF and Word (.docx) documents are accepted", "UNSUPPORTED_TYPE");
  }
  const printPdfPath = join(workDir, "print.pdf");
  await normalisePdf(sourcePdf, printPdfPath, tools);
  const info = await inspectPdf(printPdfPath);
  const previewDir = await mkdtemp(join(workDir, "preview-"));
  const previewPaths = await renderPreviews(printPdfPath, previewDir, Math.min(3, info.pageCount), tools);
  return { detectedType, printPdfPath, pageCount: info.pageCount, pageSize: info.pageSize, previewPaths };
}
