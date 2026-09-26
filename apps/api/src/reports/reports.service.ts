import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { QueryRunner } from "typeorm";
import { CaseEntity, CustomerEntity, ReportEntity, TransactionEntity } from "@regops/db";
import { AuthUserContext, ReportDetailDto, ReportDto, ReportStatus, ReportType } from "@regops/shared";
import { AuditService } from "../audit/audit.service";
import { CasesService } from "../cases/cases.service";
import { RequestMeta } from "../users/users.service";
import { UpdateReportDto } from "./dto/update-report.dto";
import { buildCtrNarrative } from "./report-drafting";

export interface ReportFilters {
  status?: ReportStatus;
  reportType?: ReportType;
  dateFrom?: string;
  dateTo?: string;
}

/**
 * One service for both SAR and CTR (Backend Prompt 7, Section 2.1). It
 * branches on `reportType` only where the two genuinely differ:
 *   - generation (SAR: Cases.approve() writes the row itself using this
 *     module's pure report-drafting helpers; CTR: generateCtr() below),
 *   - confirmation rigor (SAR: submit -> a *different* officer confirms;
 *     CTR: one officer confirms straight from DRAFT, no submitter).
 * Every state transition is a conditional UPDATE (`WHERE status = <expected>`)
 * so two officers racing on the same report cannot both win.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly auditService: AuditService,
    private readonly casesService: CasesService,
  ) {}

  // ---------------------------------------------------------------- reads

  async findEntity(qr: QueryRunner, tenantId: string, id: string): Promise<ReportEntity> {
    const report = await qr.manager.getRepository(ReportEntity).findOne({ where: { id, tenantId } });
    if (!report) throw new NotFoundException({ code: "REPORT_NOT_FOUND", message: "Report not found." });
    return report;
  }

  toDto(r: ReportEntity): ReportDto {
    return {
      id: r.id,
      tenantId: r.tenantId,
      caseId: r.caseId,
      transactionId: r.transactionId,
      customerId: r.customerId,
      reportType: r.reportType,
      status: r.status,
      flaggedAmount: r.flaggedAmount === null ? null : Number(r.flaggedAmount),
      narrative: r.narrative,
      generatedAt: r.generatedAt.toISOString(),
      generatedBy: r.generatedBy,
      submittedBy: r.submittedBy,
      submittedAt: r.submittedAt ? r.submittedAt.toISOString() : null,
      confirmedBy: r.confirmedBy,
      confirmedAt: r.confirmedAt ? r.confirmedAt.toISOString() : null,
      nfiuReference: r.nfiuReference,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  async list(
    qr: QueryRunner,
    tenantId: string,
    filters: ReportFilters,
    page: number,
    limit: number,
  ): Promise<{ data: ReportDto[]; meta: { page: number; limit: number; total: number } }> {
    const qb = qr.manager.getRepository(ReportEntity).createQueryBuilder("r").where("r.tenant_id = :tenantId", { tenantId });
    if (filters.status) qb.andWhere("r.status = :status", { status: filters.status });
    if (filters.reportType) qb.andWhere("r.report_type = :reportType", { reportType: filters.reportType });
    if (filters.dateFrom) qb.andWhere("r.generated_at >= :dateFrom", { dateFrom: new Date(filters.dateFrom) });
    if (filters.dateTo) qb.andWhere("r.generated_at <= :dateTo", { dateTo: new Date(filters.dateTo) });
    qb.orderBy("r.generatedAt", "DESC").addOrderBy("r.id", "ASC");
    qb.skip((page - 1) * limit).take(limit);

    const [rows, total] = await qb.getManyAndCount();
    return { data: rows.map((r) => this.toDto(r)), meta: { page, limit, total } };
  }

  async toDetail(qr: QueryRunner, tenantId: string, id: string): Promise<ReportDetailDto> {
    const report = await this.findEntity(qr, tenantId, id);
    const customer = await qr.manager.getRepository(CustomerEntity).findOne({ where: { id: report.customerId, tenantId } });

    let caseSummary: ReportDetailDto["case"] = null;
    if (report.caseId) {
      const kase = await qr.manager.getRepository(CaseEntity).findOne({ where: { id: report.caseId, tenantId } });
      if (kase) {
        caseSummary = { id: kase.id, caseNumber: kase.caseNumber, status: kase.status, escalationRationale: kase.escalationRationale };
      }
    }

    let transactionSummary: ReportDetailDto["transaction"] = null;
    if (report.transactionId) {
      const t = await qr.manager.getRepository(TransactionEntity).findOne({ where: { id: report.transactionId, tenantId } });
      if (t) {
        transactionSummary = {
          id: t.id,
          cbsTransactionId: t.cbsTransactionId,
          accountNumber: t.accountNumber,
          amount: t.amount,
          currency: t.currency,
          channel: t.channel,
          type: t.type,
          occurredAt: t.occurredAt.toISOString(),
        };
      }
    }

    return {
      ...this.toDto(report),
      customer: customer ? this.casesService.toCustomerSummary(customer) : null,
      case: caseSummary,
      transaction: transactionSummary,
    };
  }

  // ------------------------------------------------------------ generation

  /**
   * Section 3.3. Idempotent: `INSERT ... ON CONFLICT DO NOTHING` against the
   * partial unique index on transaction_id, so a duplicate ingestion event (or
   * two app instances handling the same one) yields exactly one CTR and the
   * loser sees `null` rather than an error — the same principle as Prompt 5's
   * deterministic BullMQ job ids, applied at the DB level. Runs on the
   * caller's tenant-scoped QueryRunner (see CtrGenerationListener).
   *
   * Returns the new report id, or null if a CTR already existed.
   */
  async generateCtr(
    qr: QueryRunner,
    tenantId: string,
    transaction: TransactionEntity,
    customer: CustomerEntity,
    threshold: number,
  ): Promise<string | null> {
    const now = new Date();
    const result = await qr.manager
      .createQueryBuilder()
      .insert()
      .into(ReportEntity)
      .values({
        tenantId,
        caseId: null,
        transactionId: transaction.id,
        customerId: transaction.customerId,
        reportType: ReportType.CTR,
        status: ReportStatus.DRAFT,
        flaggedAmount: Number(transaction.amount).toFixed(2),
        narrative: buildCtrNarrative({
          amount: transaction.amount,
          customerName: customer.fullName,
          occurredAt: transaction.occurredAt,
          channel: transaction.channel,
          threshold,
        }),
        generatedAt: now,
        generatedBy: null,
      })
      .orIgnore()
      .returning("id")
      .execute();

    const rows = result.raw as { id: string }[];
    if (!rows || rows.length === 0) return null;

    await this.auditService.record(qr, {
      tenantId,
      userId: null,
      action: "report.generated",
      entityType: "report",
      entityId: rows[0].id,
      afterState: { reportType: ReportType.CTR, transactionId: transaction.id, status: ReportStatus.DRAFT, thresholdApplied: threshold },
    });
    return rows[0].id;
  }

  // ----------------------------------------------------------------- edit

  /** Section 3.4 — DRAFT only, narrative/flaggedAmount only. */
  async update(qr: QueryRunner, tenantId: string, id: string, dto: UpdateReportDto, currentUser: AuthUserContext, meta: RequestMeta): Promise<ReportDetailDto> {
    const report = await this.findEntity(qr, tenantId, id);
    if (report.status !== ReportStatus.DRAFT) throw this.notEditable(report.status);

    const patch: Partial<ReportEntity> = {};
    if (dto.narrative !== undefined) patch.narrative = dto.narrative;
    if (dto.flaggedAmount !== undefined) patch.flaggedAmount = dto.flaggedAmount.toFixed(2);
    if (Object.keys(patch).length === 0) {
      throw new BadRequestException({ code: "NO_EDITABLE_FIELDS", message: "Provide narrative and/or flaggedAmount." });
    }

    // Conditional on DRAFT: a concurrent submit/confirm wins cleanly instead of being silently overwritten.
    const res = await qr.manager.getRepository(ReportEntity).update({ id, tenantId, status: ReportStatus.DRAFT }, patch);
    if (!res.affected) throw this.notEditable(ReportStatus.PENDING_CONFIRMATION);

    await this.auditService.record(qr, {
      tenantId,
      userId: currentUser.sub,
      action: "report.edited",
      entityType: "report",
      entityId: id,
      beforeState: { narrative: report.narrative, flaggedAmount: report.flaggedAmount },
      afterState: { narrative: patch.narrative ?? report.narrative, flaggedAmount: patch.flaggedAmount ?? report.flaggedAmount },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    return this.toDetail(qr, tenantId, id);
  }

  private notEditable(status: ReportStatus): ConflictException {
    return new ConflictException({ code: "REPORT_NOT_EDITABLE", message: `A report in status ${status} cannot be edited.` });
  }

  // ------------------------------------------------------ SAR: submit step

  /** Section 3.5 — SAR only; DRAFT -> PENDING_CONFIRMATION, which locks narrative/flaggedAmount (Section 2.6). */
  async submit(qr: QueryRunner, tenantId: string, id: string, currentUser: AuthUserContext, meta: RequestMeta): Promise<ReportDetailDto> {
    const report = await this.findEntity(qr, tenantId, id);
    if (report.reportType !== ReportType.SAR) {
      throw new BadRequestException({ code: "WRONG_REPORT_TYPE", message: "Only a SAR is submitted for confirmation; a CTR is confirmed directly." });
    }
    if (report.status !== ReportStatus.DRAFT) this.invalidTransition("submit", report.status);

    const now = new Date();
    const res = await qr.manager
      .getRepository(ReportEntity)
      .update({ id, tenantId, status: ReportStatus.DRAFT }, { status: ReportStatus.PENDING_CONFIRMATION, submittedBy: currentUser.sub, submittedAt: now });
    if (!res.affected) this.invalidTransition("submit", ReportStatus.PENDING_CONFIRMATION);

    await this.auditService.record(qr, {
      tenantId,
      userId: currentUser.sub,
      action: "report.submitted",
      entityType: "report",
      entityId: id,
      beforeState: { status: report.status },
      afterState: { status: ReportStatus.PENDING_CONFIRMATION },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    return this.toDetail(qr, tenantId, id);
  }

  // -------------------------------------------------------------- confirm

  /**
   * Section 3.5 (SAR) / 3.6 (CTR).
   * SAR: PENDING_CONFIRMATION only, and the caller must not be the submitter.
   * CTR: valid directly from DRAFT — one officer, no submitter, no guard. The
   * DRAFT -> SUBMITTED step is a single atomic UPDATE (the spec's "acceptable
   * implementation choice": PENDING_CONFIRMATION is never persisted for a
   * CTR, so submittedBy/submittedAt stay null and confirmedAt is the filing time).
   */
  async confirm(qr: QueryRunner, tenantId: string, id: string, nfiuReference: string | undefined, currentUser: AuthUserContext, meta: RequestMeta): Promise<ReportDetailDto> {
    const report = await this.findEntity(qr, tenantId, id);
    const expected = report.reportType === ReportType.SAR ? ReportStatus.PENDING_CONFIRMATION : ReportStatus.DRAFT;
    if (report.status !== expected) this.invalidTransition("confirm", report.status);
    if (report.reportType === ReportType.SAR) this.assertNotSubmitter(report, currentUser, "confirm");

    const reference = nfiuReference?.trim();
    if (!reference) {
      throw new BadRequestException({ code: "NFIU_REFERENCE_REQUIRED", message: "An NFIU reference is required to confirm a report." });
    }

    const now = new Date();
    const res = await qr.manager
      .getRepository(ReportEntity)
      .update({ id, tenantId, status: expected }, { status: ReportStatus.SUBMITTED, confirmedBy: currentUser.sub, confirmedAt: now, nfiuReference: reference });
    if (!res.affected) this.invalidTransition("confirm", ReportStatus.SUBMITTED);

    await this.auditService.record(qr, {
      tenantId,
      userId: currentUser.sub,
      action: "report.confirmed",
      entityType: "report",
      entityId: id,
      beforeState: { status: report.status },
      afterState: { status: ReportStatus.SUBMITTED, nfiuReference: reference, reportType: report.reportType },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    return this.toDetail(qr, tenantId, id);
  }

  // --------------------------------------------------------------- reject

  /**
   * Section 3.5 (SAR) / 3.6 (CTR). SAR: PENDING_CONFIRMATION -> DRAFT, clears
   * submittedBy/submittedAt so resubmission is a genuine new submit (same
   * reasoning as Case Management's reject-then-resubmit), submitter guard applies.
   * CTR: confirmation is a single atomic step (see confirm()), so there is no
   * persisted pending state to leave — the rejecting officer's review finding
   * is recorded (reason in the audit log) and the report stays in an editable
   * DRAFT for correction before it is confirmed. No submitter guard: a CTR
   * has no submitter.
   * The reason lives in the audit log only — the spec's schema has no column for it.
   */
  async reject(qr: QueryRunner, tenantId: string, id: string, reason: string | undefined, currentUser: AuthUserContext, meta: RequestMeta): Promise<ReportDetailDto> {
    const report = await this.findEntity(qr, tenantId, id);
    const isSar = report.reportType === ReportType.SAR;
    const allowed = isSar ? [ReportStatus.PENDING_CONFIRMATION] : [ReportStatus.DRAFT];
    if (!allowed.includes(report.status)) this.invalidTransition("reject", report.status);
    if (isSar) this.assertNotSubmitter(report, currentUser, "reject");

    const trimmed = reason?.trim();
    if (!trimmed) {
      throw new BadRequestException({ code: "REJECTION_REASON_REQUIRED", message: "A rejection reason is required." });
    }

    const res = await qr.manager
      .getRepository(ReportEntity)
      .update({ id, tenantId, status: report.status }, { status: ReportStatus.DRAFT, submittedBy: null, submittedAt: null });
    if (!res.affected) this.invalidTransition("reject", ReportStatus.SUBMITTED);

    await this.auditService.record(qr, {
      tenantId,
      userId: currentUser.sub,
      action: "report.rejected",
      entityType: "report",
      entityId: id,
      beforeState: { status: report.status, submittedBy: report.submittedBy },
      afterState: { status: ReportStatus.DRAFT, reason: trimmed, reportType: report.reportType },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    return this.toDetail(qr, tenantId, id);
  }

  private assertNotSubmitter(report: ReportEntity, currentUser: AuthUserContext, verb: "confirm" | "reject"): void {
    if (report.submittedBy === currentUser.sub) {
      throw new ForbiddenException({
        code: "CONFIRMER_CANNOT_BE_SUBMITTER",
        message: `The Compliance Officer who submitted this report cannot also ${verb} it.`,
      });
    }
  }

  private invalidTransition(action: string, status: ReportStatus): never {
    throw new ConflictException({ code: "INVALID_TRANSITION", message: `Cannot ${action} a report in status ${status}.` });
  }
}
