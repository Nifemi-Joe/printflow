// import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform} from "node:stream";
import { pipeline } from "node:stream/promises";
import { Controller, Delete, Get, HttpCode, Inject, Param, Post, Req } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { enqueueJob, withTransaction } from "../../../../packages/data/src/index.js";
import { MAX_UPLOAD_BYTES, readHead, sniffHead } from "../../../../packages/documents/src/index.js";
import { objectKeys, type ObjectStorage } from "../../../../packages/storage/src/index.js";
import type { AppConfig } from "../config.js";
import { Access, audit } from "../http/access.js";
import type { PfRequest } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { RateLimiter } from "../http/rate-limit.js";
import { parse, uuid } from "../http/validate.js";
import { CONFIG, PG_POOL, STORAGE } from "../infra/tokens.js";
import { z } from "zod";

const ACCEPTED_MIME = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/octet-stream",
]);

/**
 * Students upload the raw file as the request body (no multipart parsing), with
 * the original filename in X-Filename (URI-encoded). The body is streamed to a
 * private temp file with a hard size cap while its SHA-256 is computed.
 */
@Controller("v1/documents")
export class DocumentsController {
  constructor(
      @Inject(PG_POOL) private readonly pool: Pool,
      @Inject(CONFIG) private readonly cfg: AppConfig,
      @Inject(STORAGE) private readonly storage: ObjectStorage,
      @Inject(Access) private readonly access: Access,
      @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  private async receive(req: PfRequest): Promise<{
    path: string;
    size: number;
    sha256: string;
    filename: string;
    mime: string;
    cleanup: () => Promise<void>;
  }> {
    const mime = (req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!ACCEPTED_MIME.has(mime)) {
      throw Errors.unsupported("upload a PDF or Word (.docx) document");
    }
    const declared = Number(req.header("content-length") ?? "NaN");
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
      throw Errors.tooLarge("documents are limited to 50 MB");
    }
    let filename: string;
    try {
      filename = decodeURIComponent(req.header("x-filename") ?? "").trim();
    } catch {
      throw Errors.badRequest("X-Filename must be URI-encoded");
    }
    filename = filename.split(/[\\/]/).pop()!.slice(0, 255);
    if (!filename) throw Errors.badRequest("X-Filename header is required");

    const dir = join(this.cfg.UPLOAD_TMP_DIR ?? tmpdir(), "pf-uploads");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, randomUUID());
    const hash = createHash("sha256");
    let size = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > MAX_UPLOAD_BYTES) {
          return cb(Errors.tooLarge("documents are limited to 50 MB"));
        }
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    const cleanup = () => rm(path, { force: true });
    try {
      await pipeline(req, limiter, createWriteStream(path, { mode: 0o600 }));
    } catch (e) {
      await cleanup();
      throw e;
    }
    if (size === 0) {
      await cleanup();
      throw Errors.rule("the file is empty", "EMPTY");
    }
    const kind = sniffHead(await readHead(path));
    if (kind === null) {
      await cleanup();
      throw Errors.rule("only PDF and Word (.docx) documents are accepted", "UNSUPPORTED_TYPE");
    }
    return { path, size: (await stat(path)).size, sha256: hash.digest("hex"), filename, mime, cleanup };
  }

  private async storeVersion(req: PfRequest, assetId: string | null) {
    const st = await this.access.student(req);
    await this.limiter.hit(`upload:${st.auth.userId}`, 30, 3600);
    const file = await this.receive(req);
    try {
      const versionId = randomUUID();
      const result = await withTransaction(this.pool, async (c) => {
        let aid = assetId;
        if (aid) {
          const owned = await c.query(
              `SELECT 1 FROM document_assets WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL FOR UPDATE`,
              [aid, st.auth.userId],
          );
          if (!owned.rowCount) throw Errors.notFound("document");
        } else {
          let title = (req.header("x-title") ?? "").trim();
          try {
            title = decodeURIComponent(title);
          } catch {
            /* keep raw */
          }
          title = (title || file.filename.replace(/\.[^.]+$/, "")).slice(0, 200) || "Untitled document";
          const a = await c.query<{ id: string }>(
              `INSERT INTO document_assets (owner_user_id, university_id, title) VALUES ($1, $2, $3) RETURNING id`,
              [st.auth.userId, st.universityId, title],
          );
          aid = a.rows[0]!.id;
        }
        const next = await c.query<{ n: number }>(
            `SELECT COALESCE(max(version_number), 0) + 1 AS n FROM document_versions WHERE asset_id = $1`,
            [aid],
        );
        const key = objectKeys.original(aid, versionId);
        await this.storage.putFile(key, file.path, file.mime);
        await c.query(
            `INSERT INTO document_versions (id, asset_id, university_id, version_number, storage_key, original_filename, declared_mime, byte_size, sha256)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [versionId, aid, st.universityId, next.rows[0]!.n, key, file.filename, file.mime, file.size, file.sha256],
        );
        await enqueueJob(c, "DOCUMENT_PROCESS", { versionId }, { dedupeKey: `doc:${versionId}`, maxAttempts: 3 });
        await audit(c, {
          universityId: st.universityId,
          actorUserId: st.auth.userId,
          actorKind: "STUDENT",
          action: assetId ? "document.replaced" : "document.uploaded",
          entityType: "document_version",
          entityId: versionId,
          requestId: req.id,
          details: { bytes: file.size, sha256: file.sha256 },
        });
        return { assetId: aid, versionId, versionNumber: next.rows[0]!.n };
      });
      return {
        ...result,
        status: "PENDING",
        message: "Upload received. We are scanning and preparing your document.",
      };
    } finally {
      await file.cleanup();
    }
  }

  @Post()
  @HttpCode(202)
  upload(@Req() req: PfRequest) {
    return this.storeVersion(req, null);
  }

  /** Replacement: a new immutable version. Existing orders keep the version they were placed with. */
  @Post(":assetId/versions")
  @HttpCode(202)
  replace(@Req() req: PfRequest, @Param("assetId") assetId: string) {
    return this.storeVersion(req, parse(uuid, assetId));
  }

  @Get()
  async list(@Req() req: PfRequest) {
    const st = await this.access.student(req);
    const { rows } = await this.pool.query(
        `SELECT a.id, a.title, a.created_at AS "createdAt",
                json_build_object('id', v.id, 'versionNumber', v.version_number, 'filename', v.original_filename, 'status', v.processing_status,
                                  'scanStatus', v.scan_status, 'pageCount', v.page_count, 'pageSize', v.page_size, 'failureReason', v.failure_reason,
                                  'bytes', v.byte_size, 'createdAt', v.created_at, 'previewPages', v.preview_pages) AS "latestVersion"
         FROM document_assets a
                JOIN LATERAL (SELECT * FROM document_versions WHERE asset_id = a.id ORDER BY version_number DESC LIMIT 1) v ON true
         WHERE a.owner_user_id = $1 AND a.deleted_at IS NULL
         ORDER BY a.created_at DESC LIMIT 100`,
        [st.auth.userId],
    );
    return { items: rows };
  }

  @Get(":assetId")
  async get(@Req() req: PfRequest, @Param("assetId") assetIdRaw: string) {
    const st = await this.access.student(req);
    const assetId = parse(uuid, assetIdRaw);
    const a = await this.pool.query(
        `SELECT id, title, created_at AS "createdAt" FROM document_assets WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL`,
        [assetId, st.auth.userId],
    );
    if (!a.rows[0]) throw Errors.notFound("document");
    const v = await this.pool.query(
        `SELECT id, version_number AS "versionNumber", original_filename AS filename, processing_status AS status, scan_status AS "scanStatus",
                scan_engine AS "scanEngine", page_count AS "pageCount", page_size AS "pageSize", failure_reason AS "failureReason", byte_size AS bytes,
                sha256, print_sha256 AS "printSha256", preview_pages AS "previewPages", files_purged_at AS "filesPurgedAt", created_at AS "createdAt"
         FROM document_versions WHERE asset_id = $1 ORDER BY version_number DESC`,
        [assetId],
    );
    return { ...a.rows[0], versions: v.rows };
  }

  private async ownedReadyVersion(
      userId: string,
      versionId: string,
  ): Promise<{
    asset_id: string;
    print_storage_key: string | null;
    preview_pages: number | null;
    original_filename: string;
    processing_status: string;
    files_purged_at: Date | null;
  }> {
    const { rows } = await this.pool.query<{
      asset_id: string;
      print_storage_key: string | null;
      preview_pages: number | null;
      original_filename: string;
      processing_status: string;
      files_purged_at: Date | null;
    }>(
        `SELECT v.asset_id, v.print_storage_key, v.preview_pages, v.original_filename, v.processing_status, v.files_purged_at
         FROM document_versions v JOIN document_assets a ON a.id = v.asset_id
         WHERE v.id = $1 AND a.owner_user_id = $2 AND a.deleted_at IS NULL`,
        [versionId, userId],
    );
    const v = rows[0];
    if (!v) throw Errors.notFound("document version");
    if (v.processing_status !== "READY" || v.files_purged_at) {
      throw Errors.rule("this version is not available for preview", "NOT_READY");
    }
    return v;
  }

  @Get("versions/:versionId/previews/:page")
  async preview(@Req() req: PfRequest, @Param("versionId") versionIdRaw: string, @Param("page") pageRaw: string) {
    const st = await this.access.student(req);
    const versionId = parse(uuid, versionIdRaw);
    const pageNo = parse(z.coerce.number().int().min(1).max(10), pageRaw);
    const v = await this.ownedReadyVersion(st.auth.userId, versionId);
    if (!v.preview_pages || pageNo > v.preview_pages) throw Errors.notFound("preview page");
    const url = await this.storage.signedDownloadUrl(objectKeys.preview(v.asset_id, versionId, pageNo), {
      ttlSeconds: this.cfg.SIGNED_URL_TTL_SECONDS,
      filename: `preview-${pageNo}.png`,
      contentType: "image/png",
    });
    return { url, expiresInSeconds: this.cfg.SIGNED_URL_TTL_SECONDS };
  }

  /** The exact print-ready PDF the shop will receive, for the student to check. */
  @Get("versions/:versionId/print-file")
  async printFile(@Req() req: PfRequest, @Param("versionId") versionIdRaw: string) {
    const st = await this.access.student(req);
    const versionId = parse(uuid, versionIdRaw);
    const v = await this.ownedReadyVersion(st.auth.userId, versionId);
    const url = await this.storage.signedDownloadUrl(v.print_storage_key!, {
      ttlSeconds: this.cfg.SIGNED_URL_TTL_SECONDS,
      filename: v.original_filename.replace(/\.[^.]+$/, "") + ".pdf",
      contentType: "application/pdf",
    });
    return { url, expiresInSeconds: this.cfg.SIGNED_URL_TTL_SECONDS };
  }

  /** Hides the document. Files are purged by the retention job once no active order needs them. */
  @Delete(":assetId")
  @HttpCode(204)
  async remove(@Req() req: PfRequest, @Param("assetId") assetIdRaw: string) {
    const st = await this.access.student(req);
    const assetId = parse(uuid, assetIdRaw);
    const r = await this.pool.query(
        `UPDATE document_assets SET deleted_at = now() WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL`,
        [assetId, st.auth.userId],
    );
    if (!r.rowCount) throw Errors.notFound("document");
    await enqueueJob(this.pool, "RETENTION_PURGE", { assetId }, { dedupeKey: `purge-asset:${assetId}` });
  }
}