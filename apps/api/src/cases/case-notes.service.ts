import { BadRequestException, Injectable } from "@nestjs/common";
import { QueryRunner } from "typeorm";
import { CaseNoteEntity } from "@regops/db";
import { AuthUserContext, CaseNoteDto, CaseStatus } from "@regops/shared";
import { AuditService } from "../audit/audit.service";
import { RequestMeta } from "../users/users.service";
import { CasesService } from "./cases.service";

@Injectable()
export class CaseNotesService {
  constructor(
    private readonly auditService: AuditService,
    private readonly casesService: CasesService,
  ) {}

  async addNote(
    qr: QueryRunner,
    tenantId: string,
    caseId: string,
    content: string,
    currentUser: AuthUserContext,
    meta: RequestMeta,
  ): Promise<CaseNoteDto> {
    const trimmed = content.trim();
    if (!trimmed) {
      throw new BadRequestException({ code: "CONTENT_REQUIRED", message: "Note content is required." });
    }

    const kase = await this.casesService.findEntity(qr, tenantId, caseId);
    if (kase.status === CaseStatus.CLOSED || kase.status === CaseStatus.SAR_FILED) {
      throw new BadRequestException({ code: "CASE_ALREADY_TERMINAL", message: "Cannot add a note to a closed or filed case." });
    }

    await qr.startTransaction();
    try {
      const repo = qr.manager.getRepository(CaseNoteEntity);
      const note = await repo.save(repo.create({ tenantId, caseId, userId: currentUser.sub, content: trimmed }));

      await this.casesService.maybeStartInvestigation(qr, tenantId, caseId, currentUser.sub, meta);

      await this.auditService.record(qr, {
        tenantId,
        userId: currentUser.sub,
        action: "case.note_added",
        entityType: "case",
        entityId: caseId,
        beforeState: null,
        afterState: { noteId: note.id },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      await qr.commitTransaction();
      return { id: note.id, caseId: note.caseId, userId: note.userId, content: note.content, createdAt: note.createdAt.toISOString() };
    } catch (err) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw err;
    }
  }
}
