import { createReadStream } from "node:fs";
import { connect, type Socket } from "node:net";

export type ScanResult = { verdict: "CLEAN"; engine: string } | { verdict: "INFECTED"; signature: string; engine: string } | { verdict: "ERROR"; error: string; engine: string };

export interface Scanner {
  readonly name: string;
  scanFile(path: string): Promise<ScanResult>;
}

/**
 * Minimal clamd client speaking the INSTREAM protocol over TCP:
 *   zINSTREAM\0, then <u32 BE length><bytes> chunks, then a zero-length chunk.
 * clamd replies "stream: OK" or "stream: <Signature> FOUND".
 */
export class ClamdScanner implements Scanner {
  readonly name = "clamav";

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs = 60_000,
  ) {}

  private send(command: string, body?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket: Socket = connect({ host: this.host, port: this.port });
      let reply = "";
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("clamd timed out"));
      }, this.timeoutMs);
      socket.on("connect", () => {
        socket.write(`z${command}\0`);
        if (body === undefined) return;
        const stream = createReadStream(body, { highWaterMark: 64 * 1024 });
        stream.on("data", (chunk) => {
          const buf = chunk as Buffer;
          const len = Buffer.alloc(4);
          len.writeUInt32BE(buf.length);
          if (!socket.write(Buffer.concat([len, buf]))) stream.pause();
        });
        socket.on("drain", () => stream.resume());
        stream.on("end", () => socket.write(Buffer.alloc(4)));
        stream.on("error", (e) => {
          socket.destroy();
          reject(e);
        });
      });
      socket.on("data", (d) => {
        reply += d.toString("utf8");
        if (reply.includes("\0")) socket.end();
      });
      socket.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      socket.on("close", () => {
        clearTimeout(timer);
        resolve(reply.replace(/\0/g, "").trim());
      });
    });
  }

  async version(): Promise<string> {
    return this.send("VERSION");
  }

  async scanFile(path: string): Promise<ScanResult> {
    let engine = "clamav";
    try {
      engine = (await this.version()).slice(0, 120) || engine;
      const reply = await this.send("INSTREAM", path);
      if (/^stream: OK$/.test(reply)) return { verdict: "CLEAN", engine };
      const found = /^stream: (.+) FOUND$/.exec(reply);
      if (found) return { verdict: "INFECTED", signature: found[1]!.slice(0, 200), engine };
      return { verdict: "ERROR", error: reply.slice(0, 200) || "empty reply", engine };
    } catch (e) {
      return { verdict: "ERROR", error: (e as Error).message, engine };
    }
  }
}

/**
 * Development-only stand-in. It performs NO malware detection; it exists so the
 * pipeline can run on a laptop without clamd. Configuration refuses it in
 * production, and documents record scan_engine = "none (development only)".
 */
export class NoopDevScanner implements Scanner {
  readonly name = "none";
  async scanFile(): Promise<ScanResult> {
    return { verdict: "CLEAN", engine: "none (development only - not scanned)" };
  }
}
