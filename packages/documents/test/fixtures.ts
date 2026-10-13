import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { crc32, deflateRawSync } from "node:zlib";
import { PDFDocument, StandardFonts } from "pdf-lib";

export const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

export async function makePdf(path: string, pages: number, size: [number, number] = [595.28, 841.89]): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    const p = doc.addPage(size);
    p.drawText(`PrintFlow test page ${i}`, { x: 72, y: size[1] - 96, size: 18, font });
  }
  writeFileSync(path, await doc.save());
}

interface ZipFile {
  name: string;
  data: Buffer;
  deflate?: boolean;
}

/** Minimal ZIP writer for building DOCX fixtures (and hostile archives) in tests. */
export function makeZip(path: string, files: ZipFile[]): void {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const body = f.deflate ? deflateRawSync(f.data) : f.data;
    const method = f.deflate ? 8 : 0;
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  writeFileSync(path, Buffer.concat([...locals, cd, eocd]));
}

export function docxFiles(paragraphs: string[]): ZipFile[] {
  const xml = (s: string) => Buffer.from(s, "utf8");
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("");
  return [
    {
      name: "[Content_Types].xml",
      data: xml(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
      ),
    },
    {
      name: "_rels/.rels",
      data: xml(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
      ),
    },
    {
      name: "word/document.xml",
      deflate: true,
      data: xml(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`,
      ),
    },
  ];
}

/** A fake clamd that speaks the real INSTREAM protocol and flags the EICAR test string. */
export function startFakeClamd(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      let buf = Buffer.alloc(0);
      let command: string | null = null;
      const chunks: Buffer[] = [];
      socket.on("data", (d) => {
        buf = Buffer.concat([buf, d]);
        if (command === null) {
          const nul = buf.indexOf(0);
          if (nul < 0) return;
          command = buf.subarray(0, nul).toString();
          buf = buf.subarray(nul + 1);
          if (command === "zVERSION") {
            socket.end("ClamAV 1.4.1/27420/fake\0");
            return;
          }
        }
        if (command === "zINSTREAM") {
          while (buf.length >= 4) {
            const len = buf.readUInt32BE(0);
            if (len === 0) {
              const all = Buffer.concat(chunks).toString("latin1");
              socket.end(all.includes(EICAR) ? "stream: Win.Test.EICAR_HDB-1 FOUND\0" : "stream: OK\0");
              return;
            }
            if (buf.length < 4 + len) return;
            chunks.push(buf.subarray(4, 4 + len));
            buf = buf.subarray(4 + len);
          }
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
    });
  });
}
