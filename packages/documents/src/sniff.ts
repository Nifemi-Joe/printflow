import { open } from "node:fs/promises";

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_PAGES = 2_000;

export type DetectedType = "PDF" | "DOCX";

export class DocumentRejectedError extends Error {
  override readonly name = "DocumentRejectedError";
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

/**
 * Identifies the file by its leading bytes; the declared MIME type and the
 * filename extension are never trusted.
 */
export function sniffHead(head: Buffer): "PDF" | "ZIP" | null {
  // PDF header may be preceded by up to 1024 bytes of junk per the spec; we only
  // accept it at offset 0, which every conforming generator produces.
  if (head.subarray(0, 5).toString("latin1") === "%PDF-") return "PDF";
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return "ZIP";
  return null;
}

export async function readHead(path: string, bytes = 8): Promise<Buffer> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  encrypted: boolean;
}

export const ZIP_LIMITS = {
  maxEntries: 5_000,
  maxTotalUncompressed: 250 * 1024 * 1024,
  maxRatio: 200,
} as const;

/**
 * Reads the ZIP central directory without extracting anything, so zip bombs,
 * path-traversal entries and encrypted archives are rejected before the file
 * ever reaches LibreOffice.
 */
export async function readZipCentralDirectory(path: string): Promise<ZipEntry[]> {
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new DocumentRejectedError("file is not a valid ZIP container", "BAD_ARCHIVE");
    const entries = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (entries === 0xffff || cdOffset === 0xffffffff) throw new DocumentRejectedError("ZIP64 archives are not accepted", "BAD_ARCHIVE");
    if (entries > ZIP_LIMITS.maxEntries) throw new DocumentRejectedError("archive has too many entries", "ARCHIVE_TOO_COMPLEX");
    if (cdOffset + cdSize > size) throw new DocumentRejectedError("corrupt ZIP central directory", "BAD_ARCHIVE");
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);

    const out: ZipEntry[] = [];
    let p = 0;
    for (let i = 0; i < entries; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new DocumentRejectedError("corrupt ZIP central directory", "BAD_ARCHIVE");
      const flags = cd.readUInt16LE(p + 8);
      const compressedSize = cd.readUInt32LE(p + 20);
      const uncompressedSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString("utf8");
      out.push({ name, compressedSize, uncompressedSize, encrypted: (flags & 0x1) === 1 });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  } finally {
    await fh.close();
  }
}

/** Validates that a ZIP is a plain, macro-free, safely sized Word document. */
export function assertSafeDocx(entries: readonly ZipEntry[]): void {
  const names = new Set(entries.map((e) => e.name));
  if (!names.has("[Content_Types].xml") || !names.has("word/document.xml")) {
    throw new DocumentRejectedError("only Word .docx documents are accepted", "UNSUPPORTED_TYPE");
  }
  let total = 0;
  for (const e of entries) {
    if (e.encrypted) throw new DocumentRejectedError("password-protected documents cannot be printed", "ENCRYPTED");
    if (e.name.startsWith("/") || e.name.includes("..") || e.name.includes("\\")) {
      throw new DocumentRejectedError("archive contains unsafe paths", "BAD_ARCHIVE");
    }
    if (/vbaProject\.bin$/i.test(e.name) || /activeX/i.test(e.name)) {
      throw new DocumentRejectedError("documents with macros or ActiveX controls are not accepted", "MACROS");
    }
    total += e.uncompressedSize;
    if (e.compressedSize > 0 && e.uncompressedSize / e.compressedSize > ZIP_LIMITS.maxRatio && e.uncompressedSize > 1_000_000) {
      throw new DocumentRejectedError("archive compression ratio is suspicious", "ARCHIVE_BOMB");
    }
  }
  if (total > ZIP_LIMITS.maxTotalUncompressed) throw new DocumentRejectedError("document expands beyond the size limit", "ARCHIVE_BOMB");
}
