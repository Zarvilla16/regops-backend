import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { QueryRunner } from "typeorm";
import { AlertEntity, CaseAlertEntity, CaseAssignmentEventEntity, CaseEntity, CaseNoteEntity, CustomerEntity } from "@regops/db";
import {
  AlertSeverity,
  AuthUserContext,
  CaseCustomerSummaryDto,
  CaseDetailDto,
  CaseDto,
  CaseListItemDto,
  CaseNoteDto,
  CasePriority,
  CaseStatus,
} from "@regops/shared";
import { AuditService } from "../audit/audit.service";
import { RequestMeta } from "../users/users.service";
import { CreateCaseDto } from "./dto/create-case.dto";

export interface CaseFilters {
  statuses?: CaseStatus[];
  priorities?: CasePriority[];
  assignedTo?: string;
  q?: string;
}

@Injectable()
export class CasesService {
  constructor(private readonly auditService: AuditService) {}

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

  /** Section 3.2: fires the first time a note is added, evidence is
   * uploaded, or a linked alert's status changes away from NEW — but ONLY
   * while the case is still OPEN (a case already UNDER_INVESTIGATION or
   * later doesn't re-fire or produce a duplicate transition). Callers MUST
   * invoke this inside their own already-open transaction — it does not
   * open or commit one itself. Silently no-ops on a stale/cross-tenant
   * caseId (the caller's own lookup already 404'd before reaching here in
   * every real call site; this only guards a hypothetical race). */
  async maybeStartInvestigation(qr: QueryRunner, tenantId: string, caseId: string): Promise<void> {
    const repo = qr.manager.getRepository(CaseEntity);
    const kase = await repo.findOne({ where: { id: caseId, tenantId } });
    if (!kase || kase.status !== CaseStatus.OPEN) return;
    await repo.update({ id: caseId }, { status: CaseStatus.UNDER_INVESTIGATION });
  }

  async listNotes(qr: QueryRunner, tenantId: string, caseId: string): Promise<CaseNoteDto[]> {
    const notes = await qr.manager.getRepository(CaseNoteEntity).find({ where: { tenantId, caseId }, order: { createdAt: "ASC" } });
    return notes.map((n) => ({ id: n.id, caseId: n.caseId, userId: n.userId, content: n.content, createdAt: n.createdAt.toISOString() }));
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

    return {
      ...this.toDto(kase),
      customer: customer ? this.toCustomerSummary(customer) : null,
      alerts: alerts.map((a) => ({ id: a.id, title: a.title, severity: a.severity, status: a.status, scenario: a.scenarioType })),
      notes: await this.listNotes(qr, tenantId, id),
      evidence: [],
      transactions: [],
      timeline: [],
      checklist: { items: [], complete: false },
      report: null,
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
