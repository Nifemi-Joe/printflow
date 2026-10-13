import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { assertSafeKey } from "./keys.js";
import { safeDownloadName, signGrant } from "./signed-url.js";

export interface SignedUrlOptions {
  ttlSeconds: number;
  filename: string;
  contentType: string;
}

/** Private object storage. Nothing stored here is ever publicly readable. */
export interface ObjectStorage {
  readonly driver: "LOCAL" | "S3";
  putFile(key: string, filePath: string, contentType: string): Promise<void>;
  putBuffer(key: string, body: Buffer, contentType: string): Promise<void>;
  getStream(key: string): Promise<Readable>;
  downloadToFile(key: string, filePath: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  signedDownloadUrl(key: string, opts: SignedUrlOptions): Promise<string>;
}

export const MAX_SIGNED_URL_TTL_SECONDS = 300;

function clampTtl(ttl: number): number {
  return Math.max(10, Math.min(MAX_SIGNED_URL_TTL_SECONDS, Math.floor(ttl)));
}

/** Filesystem driver for development and single-node installs. */
export class LocalStorage implements ObjectStorage {
  readonly driver = "LOCAL" as const;
  private readonly root: string;

  constructor(
    rootDir: string,
    private readonly signingSecret: string,
    private readonly publicApiBaseUrl: string,
  ) {
    if (signingSecret.length < 32) throw new Error("storage signing secret must be at least 32 characters");
    this.root = resolve(rootDir);
  }

  private pathFor(key: string): string {
    assertSafeKey(key);
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error("resolved path escapes storage root");
    return p;
  }

  async putFile(key: string, filePath: string, _contentType?: string): Promise<void> {
    const dest = this.pathFor(key);
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
    await pipeline(createReadStream(filePath), createWriteStream(dest, { mode: 0o600 }));
  }

  async putBuffer(key: string, body: Buffer, _contentType?: string): Promise<void> {
    const dest = this.pathFor(key);
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
    await pipeline(Readable.from([body]), createWriteStream(dest, { mode: 0o600 }));
  }

  async getStream(key: string): Promise<Readable> {
    const p = this.pathFor(key);
    await stat(p);
    return createReadStream(p);
  }

  async downloadToFile(key: string, filePath: string): Promise<void> {
    await pipeline(await this.getStream(key), createWriteStream(filePath, { mode: 0o600 }));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async signedDownloadUrl(key: string, opts: SignedUrlOptions): Promise<string> {
    const token = signGrant(this.signingSecret, {
      k: assertSafeKey(key),
      e: Math.floor(Date.now() / 1000) + clampTtl(opts.ttlSeconds),
      f: safeDownloadName(opts.filename),
      c: opts.contentType,
    });
    return `${this.publicApiBaseUrl.replace(/\/$/, "")}/v1/files/${token}`;
  }
}

/** S3-compatible driver (AWS S3, MinIO, Cloudflare R2, DigitalOcean Spaces). */
export class S3Storage implements ObjectStorage {
  readonly driver = "S3" as const;
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    config: { endpoint?: string; region: string; accessKeyId: string; secretAccessKey: string; forcePathStyle?: boolean },
  ) {
    this.client = new S3Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      forcePathStyle: config.forcePathStyle ?? Boolean(config.endpoint),
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
  }

  async putFile(key: string, filePath: string, contentType: string): Promise<void> {
    const size = (await stat(filePath)).size;
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: assertSafeKey(key), Body: createReadStream(filePath), ContentLength: size, ContentType: contentType, ServerSideEncryption: "AES256" }),
    );
  }

  async putBuffer(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: assertSafeKey(key), Body: body, ContentType: contentType, ServerSideEncryption: "AES256" }));
  }

  async getStream(key: string): Promise<Readable> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: assertSafeKey(key) }));
    if (!res.Body) throw new Error("empty object body");
    return res.Body as Readable;
  }

  async downloadToFile(key: string, filePath: string): Promise<void> {
    await pipeline(await this.getStream(key), createWriteStream(filePath, { mode: 0o600 }));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: assertSafeKey(key) }));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: assertSafeKey(key) }));
  }

  async signedDownloadUrl(key: string, opts: SignedUrlOptions): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: assertSafeKey(key),
        ResponseContentDisposition: `attachment; filename="${safeDownloadName(opts.filename)}"`,
        ResponseContentType: opts.contentType,
      }),
      { expiresIn: clampTtl(opts.ttlSeconds) },
    );
  }
}

export interface StorageConfig {
  STORAGE_DRIVER: "LOCAL" | "S3";
  STORAGE_DIR?: string | undefined;
  STORAGE_SIGNING_SECRET?: string | undefined;
  PUBLIC_API_URL: string;
  S3_ENDPOINT?: string | undefined;
  S3_REGION?: string | undefined;
  S3_BUCKET?: string | undefined;
  S3_ACCESS_KEY_ID?: string | undefined;
  S3_SECRET_ACCESS_KEY?: string | undefined;
}

export function createStorage(cfg: StorageConfig): ObjectStorage {
  if (cfg.STORAGE_DRIVER === "S3") {
    if (!cfg.S3_BUCKET || !cfg.S3_REGION || !cfg.S3_ACCESS_KEY_ID || !cfg.S3_SECRET_ACCESS_KEY) {
      throw new Error("S3 storage requires S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY");
    }
    return new S3Storage(cfg.S3_BUCKET, {
      region: cfg.S3_REGION,
      accessKeyId: cfg.S3_ACCESS_KEY_ID,
      secretAccessKey: cfg.S3_SECRET_ACCESS_KEY,
      ...(cfg.S3_ENDPOINT ? { endpoint: cfg.S3_ENDPOINT } : {}),
    });
  }
  if (!cfg.STORAGE_DIR || !cfg.STORAGE_SIGNING_SECRET) throw new Error("LOCAL storage requires STORAGE_DIR and STORAGE_SIGNING_SECRET");
  return new LocalStorage(cfg.STORAGE_DIR, cfg.STORAGE_SIGNING_SECRET, cfg.PUBLIC_API_URL);
}
