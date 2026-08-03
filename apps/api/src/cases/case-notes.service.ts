import { BadRequestException, Injectable } from "@nestjs/common";
import { QueryRunner } from "typeorm";
import { CaseNoteEntity } from "@regops/db";
import { AuthUserContext, CaseNoteDto } from "@regops/shared";
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

    await this.casesService.findEntity(qr, tenantId, caseId);

    await qr.startTransaction();
    try {
      const repo = qr.manager.getRepository(CaseNoteEntity);
      const note = await repo.save(repo.create({ tenantId, caseId, userId: currentUser.sub, content: trimmed }));

      await this.casesService.maybeStartInvestigation(qr, tenantId, caseId);

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
