import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertSafeKey, LocalStorage, objectKeys, safeDownloadName, signGrant, UnsafeKeyError, verifyGrant } from "../src/index.js";

const SECRET = "storage-signing-secret-0123456789abcdef";

describe("object keys", () => {
  it("accepts only server-generated shapes", () => {
    const a = randomUUID();
    const v = randomUUID();
    expect(objectKeys.original(a, v)).toBe(`docs/${a}/${v}`);
    expect(objectKeys.print(a, v)).toBe(`print/${a}/${v}.pdf`);
    expect(objectKeys.preview(a, v, 1)).toBe(`preview/${a}/${v}/1.png`);
  });

  it.each(["docs/../../etc/passwd", "/etc/passwd", "docs/a/b", "print/x.pdf", "docs/" + "a".repeat(36) + "/../x", ""])("rejects %s", (k) => {
    expect(() => assertSafeKey(k)).toThrow(UnsafeKeyError);
  });
});

describe("signed download grants", () => {
  const key = objectKeys.print(randomUUID(), randomUUID());

  it("round-trips and expires", () => {
    const t = signGrant(SECRET, { k: key, e: 1000, f: "a.pdf", c: "application/pdf" });
    expect(verifyGrant(SECRET, t, 999)).toMatchObject({ ok: true });
    expect(verifyGrant(SECRET, t, 1001)).toEqual({ ok: false, reason: "EXPIRED" });
  });

  it("rejects tampering and wrong secrets", () => {
    const t = signGrant(SECRET, { k: key, e: 9_999_999_999, f: "a.pdf", c: "application/pdf" });
    const [payload, mac] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ k: objectKeys.print(randomUUID(), randomUUID()), e: 9_999_999_999, f: "a", c: "x" })).toString("base64url");
    expect(verifyGrant(SECRET, `${forged}.${mac}`)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    expect(verifyGrant(SECRET + "x", t)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    expect(verifyGrant(SECRET, `${payload}`)).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("sanitises download filenames", () => {
    expect(safeDownloadName('../../evil"name.pdf')).toBe("evilname.pdf");
    expect(safeDownloadName("..")).toBe("document.pdf");
    expect(safeDownloadName("Résumé final.pdf")).toBe("Resume final.pdf");
  });
});

describe("LocalStorage", () => {
  it("stores, reads, signs and deletes inside its root only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pf-store-"));
    const s = new LocalStorage(dir, SECRET, "http://localhost:4000");
    const key = objectKeys.original(randomUUID(), randomUUID());
    const src = join(dir, "src.bin");
    writeFileSync(src, "hello");
    await s.putFile(key, src, "application/pdf");
    expect(await s.exists(key)).toBe(true);
    const out = join(dir, "out.bin");
    await s.downloadToFile(key, out);
    expect(readFileSync(out, "utf8")).toBe("hello");
    const url = await s.signedDownloadUrl(key, { ttlSeconds: 60, filename: "x.pdf", contentType: "application/pdf" });
    const token = url.split("/v1/files/")[1]!;
    const v = verifyGrant(SECRET, token);
    expect(v.ok && v.grant.k).toBe(key);
    expect(v.ok && v.grant.e - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(60);
    await s.delete(key);
    expect(await s.exists(key)).toBe(false);
    await expect(s.putBuffer("docs/../../x", Buffer.from("x"), "x")).rejects.toThrow(UnsafeKeyError);
  });

  it("clamps signed URL lifetimes to five minutes", async () => {
    const s = new LocalStorage(mkdtempSync(join(tmpdir(), "pf-store-")), SECRET, "http://x");
    const url = await s.signedDownloadUrl(objectKeys.original(randomUUID(), randomUUID()), { ttlSeconds: 86_400, filename: "x", contentType: "x" });
    const v = verifyGrant(SECRET, url.split("/v1/files/")[1]!);
    expect(v.ok && v.grant.e - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(300);
  });
});
