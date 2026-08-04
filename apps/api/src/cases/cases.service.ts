import { BadRequestException, ConflictException, forwardRef, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { QueryRunner } from "typeorm";
import {
  AlertEntity,
  CaseAlertEntity,
  CaseApprovalEventEntity,
  CaseAssignmentEventEntity,
  CaseEntity,
  CaseEvidenceEntity,
  CaseNoteEntity,
  CustomerEntity,
  ReportEntity,
  TransactionEntity,
} from "@regops/db";
import {
  AlertSeverity,
  AlertStatus,
  AuthUserContext,
  CaseApprovalOutcome,
  CaseChecklistDto,
  CaseChecklistItemDto,
  CaseCustomerSummaryDto,
  CaseDetailDto,
  CaseDto,
  CaseEvidenceDto,
  CaseListItemDto,
  CaseNoteDto,
  CasePriority,
  CaseStatus,
  ReportStatus,
  ReportType,
  RiskLevel,
  TransactionDto,
} from "@regops/shared";
import { AuditService } from "../audit/audit.service";
import { RequestMeta } from "../users/users.service";
import { CaseTimelineService } from "./case-timeline.service";
import { CreateCaseDto } from "./dto/create-case.dto";

export interface CaseFilters {
  statuses?: CaseStatus[];
  priorities?: CasePriority[];
  assignedTo?: string;
  q?: string;
}

@Injectable()
export class CasesService {
  constructor(
    private readonly auditService: AuditService,
    @Inject(forwardRef(() => CaseTimelineService))
    private readonly caseTimelineService: CaseTimelineService,
  ) {}

  /** Section 3.1: `CASE-<year>-####`, sequence = (max existing sequence for
   * this tenant+year) + 1 — recomputed per call, not a stored counter row
   * (matches the mock's nextCaseNumber exactly, per the spec's explicit
   * instruction not to introduce a counter table). Callers MUST invoke this
   * inside the request's already-open transaction; under concurrent case
   * creation for the same tenant+year this can race to a duplicate suffix,
   * which the (tenant_id, case_number) unique index would then reject as a
   * 500 — an accepted, documented limitation carried over from the mock's
   * own non-atomic approach, not something this prompt was asked to fix. */
  private async nextCaseNumber(qr: QueryRunner, tenantId: string): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `CASE-${year}-`;
    const rows: { case_number: string }[] = await qr.manager.query(
      `SELECT case_number FROM "case" WHERE tenant_id = $1 AND case_number LIKE $2 ORDER BY case_number DESC LIMIT 1`,
      [tenantId, `${prefix}%`],
    );
    const lastSeq = rows.length > 0 ? parseInt(rows[0].case_number.slice(prefix.length), 10) : 0;
    return `${prefix}${String(lastSeq + 1).padStart(4, "0")}`;
  }

  /** Section 3.1: three entry points, one path. alertId's customerId always
   * wins over any customerId also present in the body. */
  async create(qr: QueryRunner, tenantId: string, dto: CreateCaseDto, currentUser: AuthUserContext, meta: RequestMeta): Promise<CaseDetailDto> {
    let alert: AlertEntity | null = null;
    let customerId = dto.customerId ?? null;

    if (dto.alertId) {
      alert = await qr.manager.getRepository(AlertEntity).findOne({ where: { id: dto.alertId, tenantId } });
      if (!alert) throw new NotFoundException({ code: "ALERT_NOT_FOUND", message: "Alert not found." });
      customerId = alert.customerId;
    }

    if (!customerId) {
      throw new BadRequestException({ code: "CUSTOMER_REQUIRED", message: "A customerId or alertId is required." });
    }

    const customer = await qr.manager.getRepository(CustomerEntity).findOne({ where: { id: customerId, tenantId } });
    if (!customer) throw new NotFoundException({ code: "CUSTOMER_NOT_FOUND", message: "Customer not found." });

    let priority = dto.priority;
    if (!priority) {
      if (alert) {
        priority = alert.severity === AlertSeverity.CRITICAL || alert.severity === AlertSeverity.HIGH ? CasePriority.HIGH : CasePriority.MEDIUM;
      } else {
        priority = CasePriority.MEDIUM;
      }
    }

    await qr.startTransaction();
    try {
      const caseNumber = await this.nextCaseNumber(qr, tenantId);
      // Computed once and reused for created_at/the assignment event's at/the
      // case_alert's linked_at (below) — NOT left to @CreateDateColumn's own
      // DB-side now() default. Task 11's timeline needs to tell "linked at
      // creation" apart from "linked later" by exact timestamp equality
      // (linked_at === case.created_at); Postgres's now() returns
      // transaction-START time while a JS `new Date()` called moments later
      // inside that same transaction is always >= it, so relying on the
      // column default here would make every creation-time link look "later
      // than creation" and wrongly get its own "Alert linked" timeline entry
      // in addition to being counted in the "Opened" event's alert count.
      const now = new Date();
      const caseRepo = qr.manager.getRepository(CaseEntity);
      const kase = await caseRepo.save(
        caseRepo.create({
          tenantId,
          caseNumber,
          customerId,
          status: CaseStatus.OPEN,
          priority,
          assignedTo: currentUser.sub,
          createdBy: currentUser.sub,
          createdAt: now,
        }),
      );

      const assignmentRepo = qr.manager.getRepository(CaseAssignmentEventEntity);
      await assignmentRepo.save(
        assignmentRepo.create({ tenantId, caseId: kase.id, assignedTo: currentUser.sub, assignedBy: currentUser.sub, at: now }),
      );

      if (alert) {
        const caseAlertRepo = qr.manager.getRepository(CaseAlertEntity);
        await caseAlertRepo.save(
          caseAlertRepo.create({ tenantId, caseId: kase.id, alertId: alert.id, linkedAt: now, linkedBy: currentUser.sub }),
        );
      }

      await this.auditService.record(qr, {
        tenantId,
        userId: currentUser.sub,
        action: "case.opened",
        entityType: "case",
        entityId: kase.id,
        beforeState: null,
        afterState: { caseNumber, status: kase.status, customerId, alertIds: alert ? [alert.id] : [] },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      await qr.commitTransaction();
      return this.toDetail(qr, tenantId, kase.id);
    } catch (err) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw err;
    }
  }

  async findEntity(qr: QueryRunner, tenantId: string, id: string): Promise<CaseEntity> {
    const kase = await qr.manager.getRepository(CaseEntity).findOne({ where: { id, tenantId } });
    if (!kase) throw new NotFoundException({ code: "CASE_NOT_FOUND", message: "Case not found." });
    return kase;
  }

  /** Section 2.3/3.5. The existingLink pre-check plus the migration's
   * unique-on-alert_id index together satisfy Section 3.5's instruction to
   * "check the constraint at the application level for a clean error, not
   * just letting the DB constraint throw" — a genuinely concurrent double-
   * link race (two requests linking the same alert at the same instant)
   * would still surface as a raw constraint-violation 500 from the small
   * window between this check and the insert; that residual race is
   * accepted, not additionally guarded (same class of limitation as
   * nextCaseNumber's case-number race — the spec doesn't ask for advisory
   * locking here). */
  async linkAlert(
    qr: QueryRunner,
    tenantId: string,
    caseId: string,
    alertId: string,
    currentUser: AuthUserContext,
    meta: RequestMeta,
  ): Promise<CaseDetailDto> {
    const kase = await this.findEntity(qr, tenantId, caseId);
    if (kase.status === CaseStatus.CLOSED || kase.status === CaseStatus.SAR_FILED) {
      throw new BadRequestException({ code: "CASE_ALREADY_TERMINAL", message: "Cannot link an alert to a closed or filed case." });
    }

    const alert = await qr.manager.getRepository(AlertEntity).findOne({ where: { id: alertId, tenantId } });
    if (!alert) throw new NotFoundException({ code: "ALERT_NOT_FOUND", message: "Alert not found." });
    if (alert.customerId !== kase.customerId) {
      throw new BadRequestException({ code: "ALERT_CUSTOMER_MISMATCH", message: "This alert does not belong to the case's customer." });
    }

    const existingLink = await qr.manager.getRepository(CaseAlertEntity).findOne({ where: { tenantId, alertId } });
    if (existingLink) {
      throw new BadRequestException({ code: "ALERT_ALREADY_LINKED", message: "This alert is already linked to a case." });
    }

    await qr.startTransaction();
    try {
      const repo = qr.manager.getRepository(CaseAlertEntity);
      await repo.save(repo.create({ tenantId, caseId, alertId, linkedAt: new Date(), linkedBy: currentUser.sub }));

      await this.auditService.record(qr, {
        tenantId,
        userId: currentUser.sub,
        action: "case.alert_linked",
        entityType: "case",
        entityId: caseId,
        beforeState: null,
        afterState: { alertId },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      await qr.commitTransaction();
      return this.toDetail(qr, tenantId, caseId);
    } catch (err) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw err;
    }
  }

  /** Section 3.2/4.8 — not a status transition, but rejected on an already-
   * terminal case (see this task's note above). */
  async assign(
    qr: QueryRunner,
    tenantId: string,
    caseId: string,
    assignedTo: string | null,
    currentUser: AuthUserContext,
    meta: RequestMeta,
  ): Promise<CaseDetailDto> {
    const kase = await this.findEntity(qr, tenantId, caseId);
    if (kase.status === CaseStatus.CLOSED || kase.status === CaseStatus.SAR_FILED) {
      throw new BadRequestException({ code: "CASE_ALREADY_TERMINAL", message: "Cannot reassign a closed or filed case." });
    }

    const beforeState = { assignedTo: kase.assignedTo };
    const now = new Date();

    await qr.startTransaction();
    try {
      await qr.manager.getRepository(CaseEntity).update({ id: caseId }, { assignedTo });

      const assignmentRepo = qr.manager.getRepository(CaseAssignmentEventEntity);
      await assignmentRepo.save(assignmentRepo.create({ tenantId, caseId, assignedTo, assignedBy: currentUser.sub, at: now }));

      await this.auditService.record(qr, {
        tenantId,
        userId: currentUser.sub,
        action: "case.reassigned",
        entityType: "case",
        entityId: caseId,
        beforeState,
        afterState: { assignedTo },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      await qr.commitTransaction();
      return this.toDetail(qr, tenantId, caseId);
    } catch (err) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw err;
    }
  }

  /** Exact string from the frontend mock's DEFAULT_CLOSURE_REASON
   * (apps/web/src/lib/mock-data/routes.ts) — Section 3.2 requires reusing it verbatim. */
  private static readonly DEFAULT_CLOSURE_REASON = "False positive — no suspicious activity confirmed after investigation.";

  /** Section 3.2: OPEN/UNDER_INVESTIGATION -> CLOSED only. COMPLIANCE_OFFICER only (role gate is on the controller). */
  async close(qr: QueryRunner, tenantId: string, caseId: string, closureReason: string | undefined, currentUser: AuthUserContext, meta: RequestMeta): Promise<CaseDetailDto> {
    const kase = await this.findEntity(qr, tenantId, caseId);
    if (kase.status !== CaseStatus.OPEN && kase.status !== CaseStatus.UNDER_INVESTIGATION) {
      throw new ConflictException({ code: "INVALID_TRANSITION", message: `Cannot close a case in status ${kase.status}.` });
    }
    const reason = closureReason?.trim() ? closureReason.trim() : CasesService.DEFAULT_CLOSURE_REASON;
    const beforeState = { status: kase.status };

    await qr.startTransaction();
    try {
      await qr.manager
        .getRepository(CaseEntity)
        .update({ id: caseId }, { status: CaseStatus.CLOSED, closedAt: new Date(), closedBy: currentUser.sub, closureReason: reason });

      await this.auditService.record(qr, {
        tenantId,
        userId: currentUser.sub,
        action: "case.closed",
        entityType: "case",
        entityId: caseId,
        beforeState,
        afterState: { status: CaseStatus.CLOSED, closureReason: reason },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      await qr.commitTransaction();
      return this.toDetail(qr, tenantId, caseId);
    } catch (err) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw err;
    }
  }

  /** Section 3.2: OPEN/UNDER_INVESTIGATION -> PENDING_APPROVAL. Enforcement
   * order matches the mock exactly: role (controller) -> separation-of-
   * duties -> checklist completeness -> rationale non-empty. */
  async submit(
    qr: QueryRunner,
    tenantId: string,
    caseId: string,
    escalationRationale: string | undefined,
    currentUser: AuthUserContext,
    meta: RequestMeta,
  ): Promise<CaseDetailDto> {
    const kase = await this.findEntity(qr, tenantId, caseId);
    if (kase.status !== CaseStatus.OPEN && kase.status !== CaseStatus.UNDER_INVESTIGATION) {
      throw new ConflictException({ code: "INVALID_TRANSITION", message: `Cannot submit a case in status ${kase.status} for approval.` });
    }
    if (currentUser.sub === kase.assignedTo) {
      throw new ForbiddenException({ code: "SUBMITTER_CANNOT_BE_ASSIGNEE", message: "The case's own assignee cannot submit it for approval." });
    }

    const checklist = await this.computeChecklist(qr, tenantId, caseId);
    if (!checklist.complete) {
      throw new BadRequestException({
        code: "ESCALATION_CHECKLIST_INCOMPLETE",
        message: "The escalation checklist is not complete.",
        details: { failedItems: checklist.items.filter((i) => !i.passed).map((i) => i.key) },
      });
    }

    const rationale = escalationRationale?.trim();
    if (!rationale) {
      throw new BadRequestException({ code: "ESCALATION_RATIONALE_REQUIRED", message: "A non-empty escalation rationale is required." });
    }

    const beforeState = { status: kase.status };
    await qr.startTransaction();
    try {
      await qr.manager.getRepository(CaseEntity).update(
        { id: caseId },
        { status: CaseStatus.PENDING_APPROVAL, submittedBy: currentUser.sub, submittedAt: new Date(), escalationRationale: rationale },
      );

      await this.auditService.record(qr, {
        tenantId,
        userId: currentUser.sub,
        action: "case.submitted_for_approval",
        entityType: "case",
        entityId: caseId,
        beforeState,
        afterState: { status: CaseStatus.PENDING_APPROVAL, escalationRationale: rationale },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      await qr.commitTransaction();
      return this.toDetail(qr, tenantId, caseId);
    } catch (err) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw err;
    }
  }

  /** Section 3.2/2.4: PENDING_APPROVAL -> SAR_FILED, in one transaction with
   * the case_approval_event row and the auto-created draft Report (report.case_id
   * is the FK Backend Prompt 7 builds the rest of the Reports module against).
   * closed_at is also set here per the schema table (Section 6): "set on
   * CLOSED or SAR_FILED" — closed_by stays null, that's the direct-close
   * path's field only. */
  async approve(qr: QueryRunner, tenantId: string, caseId: string, currentUser: AuthUserContext, meta: RequestMeta): Promise<CaseDetailDto> {
    const kase = await this.findEntity(qr, tenantId, caseId);
    if (kase.status !== CaseStatus.PENDING_APPROVAL) {
      throw new ConflictException({ code: "INVALID_TRANSITION", message: `Cannot approve a case in status ${kase.status}.` });
    }
    if (currentUser.sub === kase.submittedBy) {
      throw new ForbiddenException({ code: "APPROVER_CANNOT_BE_SUBMITTER", message: "The submitting Compliance Officer cannot also approve this case." });
    }

    const beforeState = { status: kase.status };
    const now = new Date();
    await qr.startTransaction();
    try {
      await qr.manager
        .getRepository(CaseEntity)
        .update({ id: caseId }, { status: CaseStatus.SAR_FILED, approvedBy: currentUser.sub, approvedAt: now, closedAt: now });

      const approvalRepo = qr.manager.getRepository(CaseApprovalEventEntity);
      await approvalRepo.save(
        approvalRepo.create({ tenantId, caseId, outcome: CaseApprovalOutcome.APPROVED, actor: currentUser.sub, reason: null, at: now }),
      );

      const reportRepo = qr.manager.getRepository(ReportEntity);
      await reportRepo.save(
        reportRepo.create({
          tenantId,
          caseId,
          customerId: kase.customerId,
          reportType: ReportType.SAR,
          status: ReportStatus.DRAFT,
          generatedAt: now,
          generatedBy: currentUser.sub,
        }),
      );

      await this.auditService.record(qr, {
        tenantId,
        userId: currentUser.sub,
        action: "case.approved",
        entityType: "case",
        entityId: caseId,
        beforeState,
        afterState: { status: CaseStatus.SAR_FILED },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      await qr.commitTransaction();
      return this.toDetail(qr, tenantId, caseId);
    } catch (err) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw err;
    }
  }

  /** Section 3.2: PENDING_APPROVAL -> UNDER_INVESTIGATION (never CLOSED — a
   * rejection means "needs more work," per Section 2.1's explicit decision).
   * submittedBy/submittedAt/escalationRationale are cleared so a resubmission
   * doesn't carry stale prior-submission data. */
  async reject(qr: QueryRunner, tenantId: string, caseId: string, reason: string | undefined, currentUser: AuthUserContext, meta: RequestMeta): Promise<CaseDetailDto> {
    const kase = await this.findEntity(qr, tenantId, caseId);
    if (kase.status !== CaseStatus.PENDING_APPROVAL) {
      throw new ConflictException({ code: "INVALID_TRANSITION", message: `Cannot reject a case in status ${kase.status}.` });
    }
    if (currentUser.sub === kase.submittedBy) {
      throw new ForbiddenException({ code: "APPROVER_CANNOT_BE_SUBMITTER", message: "The submitting Compliance Officer cannot also reject this case." });
    }
    const trimmedReason = reason?.trim();
    if (!trimmedReason) {
      throw new BadRequestException({ code: "REJECTION_REASON_REQUIRED", message: "A non-empty rejection reason is required." });
    }

    const beforeState = { status: kase.status };
    const now = new Date();
    await qr.startTransaction();
    try {
      await qr.manager
        .getRepository(CaseEntity)
        .update({ id: caseId }, { status: CaseStatus.UNDER_INVESTIGATION, submittedBy: null, submittedAt: null, escalationRationale: null });

      const approvalRepo = qr.manager.getRepository(CaseApprovalEventEntity);
      await approvalRepo.save(
        approvalRepo.create({ tenantId, caseId, outcome: CaseApprovalOutcome.REJECTED, actor: currentUser.sub, reason: trimmedReason, at: now }),
      );

      await this.auditService.record(qr, {
        tenantId,
        userId: currentUser.sub,
        action: "case.rejected",
        entityType: "case",
        entityId: caseId,
        beforeState,
        afterState: { status: CaseStatus.UNDER_INVESTIGATION, reason: trimmedReason },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      await qr.commitTransaction();
      return this.toDetail(qr, tenantId, caseId);
    } catch (err) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw err;
    }
  }

  /** Section 3.2: fires the first time a note is added, evidence is
   * uploaded, or a linked alert's status changes away from NEW — but ONLY
   * while the case is still OPEN (a case already UNDER_INVESTIGATION or
   * later doesn't re-fire or produce a duplicate transition). Callers MUST
   * invoke this inside their own already-open transaction — it does not
   * open or commit one itself. Silently no-ops on a stale/cross-tenant
   * caseId (the caller's own lookup already 404'd before reaching here in
   * every real call site; this only guards a hypothetical race).
   *
   * The status predicate lives IN the UPDATE's WHERE clause (not a prior
   * read used as the sole gate) so Postgres re-evaluates `status = 'OPEN'`
   * atomically as part of the write itself, after acquiring the row lock —
   * a case closed by a concurrent request between an earlier read and this
   * write can no longer be silently flipped back to UNDER_INVESTIGATION.
   * `result.affected` tells us whether the predicate matched, replacing the
   * old separate findOne()-then-check. Writes a `case.investigation_started`
   * audit row in the same transaction as the status update, matching every
   * other transition in this module — actor/meta are null on the event-
   * driven (listener) call site, which has no HTTP request/user. */
  async maybeStartInvestigation(
    qr: QueryRunner,
    tenantId: string,
    caseId: string,
    actor: string | null,
    meta: { ipAddress: string | null; userAgent: string | null } | null,
  ): Promise<void> {
    const repo = qr.manager.getRepository(CaseEntity);
    const result = await repo.update({ id: caseId, tenantId, status: CaseStatus.OPEN }, { status: CaseStatus.UNDER_INVESTIGATION });
    if (!result.affected) return; // wasn't OPEN (or doesn't exist/wrong tenant) — no-op, same as before

    await this.auditService.record(qr, {
      tenantId,
      userId: actor,
      action: "case.investigation_started",
      entityType: "case",
      entityId: caseId,
      beforeState: { status: CaseStatus.OPEN },
      afterState: { status: CaseStatus.UNDER_INVESTIGATION },
      ipAddress: meta?.ipAddress ?? null,
      userAgent: meta?.userAgent ?? null,
    });
  }

  async listNotes(qr: QueryRunner, tenantId: string, caseId: string): Promise<CaseNoteDto[]> {
    const notes = await qr.manager.getRepository(CaseNoteEntity).find({ where: { tenantId, caseId }, order: { createdAt: "ASC" } });
    return notes.map((n) => ({ id: n.id, caseId: n.caseId, userId: n.userId, content: n.content, createdAt: n.createdAt.toISOString() }));
  }

  async listEvidence(qr: QueryRunner, tenantId: string, caseId: string): Promise<CaseEvidenceDto[]> {
    const rows = await qr.manager.getRepository(CaseEvidenceEntity).find({ where: { tenantId, caseId }, order: { createdAt: "ASC" } });
    return rows.map((e) => ({
      id: e.id,
      caseId: e.caseId,
      fileName: e.fileName,
      fileType: e.fileType,
      fileSizeBytes: e.fileSizeBytes,
      uploadedBy: e.uploadedBy,
      createdAt: e.createdAt.toISOString(),
    }));
  }

  async linkedAlerts(qr: QueryRunner, tenantId: string, caseId: string): Promise<AlertEntity[]> {
    const links = await qr.manager.getRepository(CaseAlertEntity).find({ where: { tenantId, caseId } });
    if (links.length === 0) return [];
    const alertIds = links.map((l) => l.alertId);
    return qr.manager
      .getRepository(AlertEntity)
      .createQueryBuilder("a")
      .where("a.tenant_id = :tenantId", { tenantId })
      .andWhere("a.id IN (:...alertIds)", { alertIds })
      .getMany();
  }

  /** Section 3.7: derived transitively via each linked alert's own
   * evidence.relatedTransactionIds (the exact same field AlertsService.
   * relatedTransactions reads for a single alert) — deduped and sorted by
   * occurredAt. A case with zero linked alerts always has zero transactions
   * here, regardless of what evidence records exist. */
  async getDerivedTransactions(qr: QueryRunner, tenantId: string, caseId: string): Promise<TransactionDto[]> {
    const alerts = await this.linkedAlerts(qr, tenantId, caseId);
    const ids = new Set<string>();
    for (const alert of alerts) {
      const related = Array.isArray(alert.evidence?.relatedTransactionIds) ? (alert.evidence.relatedTransactionIds as string[]) : [];
      for (const id of related) ids.add(id);
    }
    if (ids.size === 0) return [];

    const rows = await qr.manager
      .getRepository(TransactionEntity)
      .createQueryBuilder("t")
      .where("t.tenant_id = :tenantId", { tenantId })
      .andWhere("t.id IN (:...ids)", { ids: Array.from(ids) })
      .getMany();

    return rows
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
      .map((t) => ({
        id: t.id,
        tenantId: t.tenantId,
        cbsTransactionId: t.cbsTransactionId,
        customerId: t.customerId,
        accountNumber: t.accountNumber,
        amount: t.amount,
        currency: t.currency,
        type: t.type,
        channel: t.channel,
        counterpartyAccount: t.counterpartyAccount,
        counterpartyBank: t.counterpartyBank,
        counterpartyName: t.counterpartyName,
        counterpartyCustomerId: t.counterpartyCustomerId,
        narration: t.narration,
        reference: t.reference,
        balanceAfter: t.balanceAfter,
        occurredAt: t.occurredAt.toISOString(),
        ingestedAt: t.ingestedAt.toISOString(),
        source: t.source,
        ingestionBatchId: t.ingestionBatchId,
      }));
  }

  /** Section 3.6 item 4: cadence by risk band — CRITICAL/HIGH 1 day, MEDIUM 7 days, LOW 30 days. */
  private isRiskScoreCurrent(customer: CustomerEntity | null): boolean {
    if (!customer || !customer.lastRiskCalculatedAt) return false;
    const cadenceDays: Record<RiskLevel, number> = {
      [RiskLevel.CRITICAL]: 1,
      [RiskLevel.HIGH]: 1,
      [RiskLevel.MEDIUM]: 7,
      [RiskLevel.LOW]: 30,
    };
    const ageMs = Date.now() - customer.lastRiskCalculatedAt.getTime();
    return ageMs <= cadenceDays[customer.riskLevel] * 24 * 60 * 60 * 1000;
  }

  /** Section 3.6 — the single source of truth for both GET /cases/:id/checklist
   * and Task 8's submit-for-approval guard. Item 3 is deliberately stricter
   * than item 1 (`every`, not `any`): a case with two linked alerts, one
   * reviewed and one still NEW, passes item 1 but fails item 3. */
  async computeChecklist(qr: QueryRunner, tenantId: string, caseId: string): Promise<CaseChecklistDto> {
    const kase = await this.findEntity(qr, tenantId, caseId);
    const alerts = await this.linkedAlerts(qr, tenantId, caseId);
    const noteCount = await qr.manager.getRepository(CaseNoteEntity).count({ where: { tenantId, caseId } });
    const transactions = await this.getDerivedTransactions(qr, tenantId, caseId);
    const customer = await qr.manager.getRepository(CustomerEntity).findOne({ where: { id: kase.customerId, tenantId } });

    const items: CaseChecklistItemDto[] = [
      { key: "ALERT_REVIEWED", label: "At least one linked alert reviewed", passed: alerts.some((a) => a.status !== AlertStatus.NEW) },
      { key: "NOTE_ADDED", label: "At least one investigation note added", passed: noteCount > 0 },
      {
        key: "TRANSACTIONS_REVIEWED",
        label: "Linked transactions reviewed",
        passed: transactions.length === 0 || alerts.every((a) => a.status !== AlertStatus.NEW),
      },
      { key: "RISK_SCORE_CURRENT", label: "Customer risk score is current", passed: this.isRiskScoreCurrent(customer) },
    ];

    return { items, complete: items.every((i) => i.passed) };
  }

  toCustomerSummary(customer: CustomerEntity): CaseCustomerSummaryDto {
    return {
      id: customer.id,
      fullName: customer.fullName,
      photoUrl: customer.photoUrl,
      riskLevel: customer.riskLevel,
      riskScore: customer.riskScore,
      kycTier: customer.kycTier,
      lastScreenedAt: customer.lastScreenedAt ? customer.lastScreenedAt.toISOString() : null,
      lastRiskCalculatedAt: customer.lastRiskCalculatedAt ? customer.lastRiskCalculatedAt.toISOString() : null,
      isPep: customer.isPep,
      isSanctioned: customer.isSanctioned,
    };
  }

  toDto(kase: CaseEntity): CaseDto {
    return {
      id: kase.id,
      tenantId: kase.tenantId,
      caseNumber: kase.caseNumber,
      customerId: kase.customerId,
      status: kase.status,
      priority: kase.priority,
      assignedTo: kase.assignedTo,
      createdBy: kase.createdBy,
      createdAt: kase.createdAt.toISOString(),
      updatedAt: kase.updatedAt.toISOString(),
      submittedBy: kase.submittedBy,
      submittedAt: kase.submittedAt ? kase.submittedAt.toISOString() : null,
      approvedBy: kase.approvedBy,
      approvedAt: kase.approvedAt ? kase.approvedAt.toISOString() : null,
      escalationRationale: kase.escalationRationale,
      closedAt: kase.closedAt ? kase.closedAt.toISOString() : null,
      closedBy: kase.closedBy,
      closureReason: kase.closureReason,
    };
  }

  /** Section 3.7. notes/evidence/transactions/timeline/checklist are filled
   * in by Tasks 4/5/6(+11 for transactions' final consumer, the checklist)/
   * 11 respectively — each replaces exactly one of the five lines below with
   * a real call, nothing else in this method changes. */
  async toDetail(qr: QueryRunner, tenantId: string, id: string): Promise<CaseDetailDto> {
    const kase = await this.findEntity(qr, tenantId, id);
    const customer = await qr.manager.getRepository(CustomerEntity).findOne({ where: { id: kase.customerId, tenantId } });
    const alerts = await this.linkedAlerts(qr, tenantId, id);
    const report = await qr.manager.getRepository(ReportEntity).findOne({ where: { tenantId, caseId: id } });

    return {
      ...this.toDto(kase),
      customer: customer ? this.toCustomerSummary(customer) : null,
      alerts: alerts.map((a) => ({ id: a.id, title: a.title, severity: a.severity, status: a.status, scenario: a.scenarioType })),
      notes: await this.listNotes(qr, tenantId, id),
      evidence: await this.listEvidence(qr, tenantId, id),
      transactions: await this.getDerivedTransactions(qr, tenantId, id),
      timeline: await this.caseTimelineService.build(qr, tenantId, kase),
      checklist: await this.computeChecklist(qr, tenantId, id),
      report: report ? { id: report.id, status: report.status } : null,
    };
  }

  /** Section 4.3. Low case volume (same order of magnitude as Alert/Rule
   * rows, not Transaction rows) makes the per-row customer-summary lookup
   * below acceptable without a batched join — same judgment call as
   * AlertsService.findAll not batching either. */
  async list(
    qr: QueryRunner,
    tenantId: string,
    filters: CaseFilters,
    page: number,
    limit: number,
  ): Promise<{ data: CaseListItemDto[]; meta: { page: number; limit: number; total: number } }> {
    const qb = qr.manager.getRepository(CaseEntity).createQueryBuilder("c").where("c.tenant_id = :tenantId", { tenantId });

    if (filters.statuses?.length) qb.andWhere("c.status IN (:...statuses)", { statuses: filters.statuses });
    if (filters.priorities?.length) qb.andWhere("c.priority IN (:...priorities)", { priorities: filters.priorities });
    if (filters.assignedTo === "unassigned") {
      qb.andWhere("c.assigned_to IS NULL");
    } else if (filters.assignedTo) {
      qb.andWhere("c.assigned_to = :assignedTo", { assignedTo: filters.assignedTo });
    }
    if (filters.q) {
      qb.leftJoin(CustomerEntity, "cust", "cust.id = c.customer_id AND cust.tenant_id = c.tenant_id");
      qb.andWhere("(c.case_number ILIKE :q OR cust.full_name ILIKE :q)", { q: `%${filters.q}%` });
    }

    // Property-path form ("c.createdAt", the TS field name), not the raw
    // "c.created_at" column name: when filters.q adds a leftJoin, TypeORM's
    // getManyAndCount() takes a distinct-subquery pagination path (any query
    // with both a join and skip/take) that resolves ORDER BY criteria via
    // EntityMetadata.findColumnWithPropertyPath, which matches column
    // *property* names, not DB column names — the raw snake_case form
    // resolves to `undefined` there and throws deep inside TypeORM.
    qb.orderBy("c.createdAt", "DESC");
    qb.skip((page - 1) * limit).take(limit);

    const [rows, total] = await qb.getManyAndCount();
    const data = await Promise.all(rows.map((r) => this.toListItem(qr, tenantId, r)));
    return { data, meta: { page, limit, total } };
  }

  private async toListItem(qr: QueryRunner, tenantId: string, kase: CaseEntity): Promise<CaseListItemDto> {
    const customer = await qr.manager.getRepository(CustomerEntity).findOne({ where: { id: kase.customerId, tenantId } });
    const alertCount = await qr.manager.getRepository(CaseAlertEntity).count({ where: { tenantId, caseId: kase.id } });
    return {
      id: kase.id,
      caseNumber: kase.caseNumber,
      customer: customer ? this.toCustomerSummary(customer) : null,
      status: kase.status,
      priority: kase.priority,
      assignedTo: kase.assignedTo,
      alertCount,
      createdAt: kase.createdAt.toISOString(),
    };
  }
}
