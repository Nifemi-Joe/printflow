import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:net";
import {
  assertSafeDocx,
  ClamdScanner,
  classifyPageSize,
  DocumentRejectedError,
  inspectPdf,
  prepareDocument,
  readZipCentralDirectory,
  sniffHead,
} from "../src/index.js";
import { docxFiles, EICAR, makePdf, makeZip, startFakeClamd } from "./fixtures.js";

const work = () => mkdtempSync(join(tmpdir(), "pf-doc-"));

describe("type detection", () => {
  it("trusts bytes, not names", () => {
    expect(sniffHead(Buffer.from("%PDF-1.7\n"))).toBe("PDF");
    expect(sniffHead(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe("ZIP");
    expect(sniffHead(Buffer.from("MZ\x90\x00"))).toBeNull();
    expect(sniffHead(Buffer.from("<html>"))).toBeNull();
  });

  it("classifies page sizes in either orientation", () => {
    expect(classifyPageSize(595, 842)).toBe("A4");
    expect(classifyPageSize(842, 595)).toBe("A4");
    expect(classifyPageSize(612, 792)).toBe("LETTER");
    expect(classifyPageSize(500, 500)).toBe("OTHER");
  });
});

describe("DOCX safety checks", () => {
  it("accepts a plain document", async () => {
    const d = work();
    makeZip(join(d, "ok.docx"), docxFiles(["Hello"]));
    expect(() => assertSafeDocx([])).toThrow(DocumentRejectedError);
    const entries = await readZipCentralDirectory(join(d, "ok.docx"));
    expect(() => assertSafeDocx(entries)).not.toThrow();
  });

  it.each([
    ["macros", [{ name: "word/vbaProject.bin", data: Buffer.from("x") }], "MACROS"],
    ["path traversal", [{ name: "../../evil.xml", data: Buffer.from("x") }], "BAD_ARCHIVE"],
    ["zip bomb", [{ name: "word/media/bomb.xml", data: Buffer.alloc(30_000_000, 0x41), deflate: true }], "ARCHIVE_BOMB"],
  ])("rejects %s", async (_label, extra, code) => {
    const d = work();
    makeZip(join(d, "bad.docx"), [...docxFiles(["x"]), ...extra]);
    const entries = await readZipCentralDirectory(join(d, "bad.docx"));
    expect(() => assertSafeDocx(entries)).toThrow(expect.objectContaining({ code }));
  });

  it("rejects ZIPs that are not Word documents", async () => {
    const d = work();
    makeZip(join(d, "x.zip"), [{ name: "hello.txt", data: Buffer.from("hi") }]);
    expect(() => assertSafeDocx([{ name: "hello.txt", compressedSize: 2, uncompressedSize: 2, encrypted: false }])).toThrow("only Word");
    await expect(prepareDocument(join(d, "x.zip"), d)).rejects.toMatchObject({ code: "UNSUPPORTED_TYPE" });
  });
});

describe("processing pipeline (real qpdf / pdftoppm / LibreOffice)", () => {
  it("prepares a PDF: page count, size, previews", async () => {
    const d = work();
    await makePdf(join(d, "in.pdf"), 7);
    const out = await prepareDocument(join(d, "in.pdf"), d);
    expect(out).toMatchObject({ detectedType: "PDF", pageCount: 7, pageSize: "A4" });
    expect(out.previewPaths).toHaveLength(3);
    expect((await inspectPdf(out.printPdfPath)).pageCount).toBe(7);
  }, 60_000);

  it("converts a DOCX to PDF and counts its pages", async () => {
    const d = work();
    makeZip(join(d, "in.docx"), docxFiles(["First paragraph", "Second paragraph"]));
    const out = await prepareDocument(join(d, "in.docx"), d);
    expect(out.detectedType).toBe("DOCX");
    expect(out.pageCount).toBeGreaterThanOrEqual(1);
    expect(out.pageSize).toBe("A4");
  }, 120_000);

  it.each([
    ["an executable renamed .pdf", Buffer.from("MZ\x90\x00 this is not a pdf"), "UNSUPPORTED_TYPE"],
    ["an empty file", Buffer.alloc(0), "EMPTY"],
    ["a truncated PDF", Buffer.from("%PDF-1.7\n1 0 obj << /Type /Catalog >>\n"), "BAD_PDF"],
  ])("rejects %s", async (_label, bytes, code) => {
    const d = work();
    writeFileSync(join(d, "bad.pdf"), bytes);
    await expect(prepareDocument(join(d, "bad.pdf"), d)).rejects.toMatchObject({ code });
  }, 60_000);

  it("enforces processing timeouts", async () => {
    const d = work();
    await makePdf(join(d, "in.pdf"), 1);
    const hang = join(d, "hang.sh");
    writeFileSync(hang, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
    const started = Date.now();
    await expect(prepareDocument(join(d, "in.pdf"), d, { soffice: "soffice", qpdf: hang, pdftoppm: "pdftoppm", timeoutMs: 300 })).rejects.toMatchObject({
      code: "PROCESSING_TIMEOUT",
    });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("ClamAV client (against a protocol-accurate fake clamd)", () => {
  let fake: { server: Server; port: number };
  beforeAll(async () => {
    fake = await startFakeClamd();
  });
  afterAll(() => {
    fake.server.close();
  });

  it("reports clean files with the engine version", async () => {
    const d = work();
    await makePdf(join(d, "ok.pdf"), 1);
    const r = await new ClamdScanner("127.0.0.1", fake.port).scanFile(join(d, "ok.pdf"));
    expect(r).toEqual({ verdict: "CLEAN", engine: "ClamAV 1.4.1/27420/fake" });
  });

  it("detects the EICAR test signature, including across chunk boundaries", async () => {
    const d = work();
    writeFileSync(join(d, "eicar.pdf"), Buffer.concat([Buffer.alloc(64 * 1024 - 10, 0x20), Buffer.from(EICAR)]));
    const r = await new ClamdScanner("127.0.0.1", fake.port).scanFile(join(d, "eicar.pdf"));
    expect(r).toMatchObject({ verdict: "INFECTED", signature: "Win.Test.EICAR_HDB-1" });
  });

  it("returns ERROR (never CLEAN) when clamd is unreachable", async () => {
    const d = work();
    await makePdf(join(d, "ok.pdf"), 1);
    const r = await new ClamdScanner("127.0.0.1", 1, 2_000).scanFile(join(d, "ok.pdf"));
    expect(r.verdict).toBe("ERROR");
  });
});
