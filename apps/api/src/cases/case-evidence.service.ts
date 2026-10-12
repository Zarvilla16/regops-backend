import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import * as crypto from "crypto";
import * as path from "path";
import { Readable } from "stream";
import { QueryRunner } from "typeorm";
import { CaseEvidenceEntity } from "@regops/db";
import { createFileStorage, FileStorage } from "@regops/file-storage";
import { AuthUserContext, CaseEvidenceDto, CaseStatus } from "@regops/shared";
import { AuditService } from "../audit/audit.service";
import { RequestMeta } from "../users/users.service";
import { CasesService } from "./cases.service";

const MAX_EVIDENCE_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Section 2.5: PDF, JPEG, PNG, DOCX, CSV — MIME type -> canonical extension. */
const ALLOWED_EVIDENCE_MIME_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "text/csv": "csv",
};

/** Filename extensions accepted per canonical type — jpg/jpeg both map to the jpeg MIME type. */
const VALID_EXTENSIONS_FOR: Record<string, string[]> = {
  pdf: ["pdf"],
  jpg: ["jpg", "jpeg"],
  png: ["png"],
  docx: ["docx"],
  csv: ["csv"],
};

@Injectable()
export class CaseEvidenceService {
  private readonly storage: FileStorage;

  constructor(
    private readonly auditService: AuditService,
    private readonly casesService: CasesService,
  ) {
    this.storage = createFileStorage(path.resolve(__dirname, "../../../../.local-storage"));
  }

  /** Section 3.4: validated by BOTH MIME type and filename extension — don't
   * trust either alone. Unlike CustomersController's photo upload (which
   * relies on Multer's own `limits.fileSize`, accepting whatever generic
   * error results from exceeding it), this endpoint's FileInterceptor sets
   * NO multer size limit — size is checked explicitly below so an oversized
   * file gets the spec's exact 400 FILE_TOO_LARGE, not an uncaught
   * MulterError surfacing as a 500 through AllExceptionsFilter. */
  async upload(
    qr: QueryRunner,
    tenantId: string,
    caseId: string,
    file: Express.Multer.File,
    currentUser: AuthUserContext,
    meta: RequestMeta,
  ): Promise<CaseEvidenceDto> {
    const ext = ALLOWED_EVIDENCE_MIME_TYPES[file.mimetype];
    if (!ext) {
      throw new BadRequestException({
        code: "INVALID_FILE_TYPE",
        message: `Unsupported content type '${file.mimetype}'. Allowed: PDF, JPEG, PNG, DOCX, CSV.`,
      });
    }
    const originalExt = path.extname(file.originalname).toLowerCase().replace(".", "");
    if (!VALID_EXTENSIONS_FOR[ext].includes(originalExt)) {
      throw new BadRequestException({
        code: "INVALID_FILE_TYPE",
        message: `File extension '.${originalExt}' does not match content type '${file.mimetype}'.`,
      });
    }
    if (file.size > MAX_EVIDENCE_UPLOAD_BYTES) {
      throw new BadRequestException({ code: "FILE_TOO_LARGE", message: "Evidence files must be 10MB or smaller." });
    }

    const kase = await this.casesService.findEntity(qr, tenantId, caseId);
    if (kase.status === CaseStatus.CLOSED || kase.status === CaseStatus.SAR_FILED) {
      throw new BadRequestException({ code: "CASE_ALREADY_TERMINAL", message: "Cannot upload evidence to a closed or filed case." });
    }

    const evidenceId = crypto.randomUUID();
    const key = `tenants/${tenantId}/cases/${caseId}/evidence/${evidenceId}.${ext}`;

    // Uploaded to FileStorage before the DB write — same "no DB row ever
    // points at a file that doesn't exist" ordering as CustomersService.uploadPhoto.
    await this.storage.upload(key, Readable.from(file.buffer));

    await qr.startTransaction();
    try {
      const repo = qr.manager.getRepository(CaseEvidenceEntity);
      const evidence = await repo.save(
        repo.create({
          id: evidenceId,
          tenantId,
          caseId,
          fileName: file.originalname,
          fileKey: key,
          fileType: file.mimetype,
          fileSizeBytes: file.size,
          uploadedBy: currentUser.sub,
        }),
      );

      await this.casesService.maybeStartInvestigation(qr, tenantId, caseId, currentUser.sub, meta);

      await this.auditService.record(qr, {
        tenantId,
        userId: currentUser.sub,
        action: "case.evidence_uploaded",
        entityType: "case",
        entityId: caseId,
        beforeState: null,
        afterState: { evidenceId: evidence.id, fileName: evidence.fileName },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      await qr.commitTransaction();
      return this.toDto(evidence);
    } catch (err) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw err;
    }
  }

  /** Proxied through the API (not a signed URL) — LocalFileStorage.getSignedDownloadUrl
   * always returns null, same reasoning as CustomersController's photo download. Still
   * writes an audit row (Section 2.5: both upload and download are audit-logged).
   *
   * Unlike every other audited write in this module, this one does NOT wrap the audit
   * write in a nested transaction/savepoint. `qr` already has the request's outer
   * transaction open (started by TenantContextMiddleware), and normally that outer
   * transaction's real COMMIT is deferred until TransactionInterceptor runs, after this
   * method's Promise resolves and control returns to Nest's response pipeline. That's
   * fine for handlers that return a DTO through the normal Nest response path (e.g.
   * `upload()` above) — but CasesController#downloadEvidence uses `@Res()` and calls
   * `stream.pipe(res)` directly on the value this method returns, which starts writing
   * bytes to the real HTTP response immediately, BEFORE TransactionInterceptor ever
   * commits. For a small file, the client can see a fully-flushed download before the
   * outer transaction's COMMIT has happened on Postgres, so the audit row wouldn't yet
   * be durably visible to any other database connection — a compliance-audit-durability
   * gap. So instead of opening a nested savepoint, we commit the ACTUAL outer transaction
   * here, synchronously, before returning the stream to the controller: that's a real
   * COMMIT, not a savepoint release, so the audit row is durable and visible to any other
   * connection before a single byte is streamed. `qr.isTransactionActive` is correctly
   * `false` after this returns; TransactionInterceptor's own
   * `if (queryRunner.isTransactionActive) commitTransaction()` guard then no-ops for this
   * request instead of double-committing. */
  async getStream(
    qr: QueryRunner,
    tenantId: string,
    caseId: string,
    evidenceId: string,
    currentUser: AuthUserContext,
    meta: RequestMeta,
  ): Promise<{ stream: Readable; contentType: string; fileName: string }> {
    await this.casesService.findEntity(qr, tenantId, caseId);
    const evidence = await qr.manager.getRepository(CaseEvidenceEntity).findOne({ where: { id: evidenceId, tenantId, caseId } });
    if (!evidence) throw new NotFoundException({ code: "EVIDENCE_NOT_FOUND", message: "Evidence not found." });

    const stream = await this.storage.getReadStream(evidence.fileKey);

    try {
      await this.auditService.record(qr, {
        tenantId,
        userId: currentUser.sub,
        action: "case.evidence_downloaded",
        entityType: "case",
        entityId: caseId,
        beforeState: null,
        afterState: { evidenceId: evidence.id },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      await qr.commitTransaction();
    } catch (err) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw err;
    }

    return { stream, contentType: evidence.fileType, fileName: evidence.fileName };
  }

  private toDto(e: CaseEvidenceEntity): CaseEvidenceDto {
    return {
      id: e.id,
      caseId: e.caseId,
      fileName: e.fileName,
      fileType: e.fileType,
      fileSizeBytes: e.fileSizeBytes,
      uploadedBy: e.uploadedBy,
      createdAt: e.createdAt.toISOString(),
    };
  }
}
