import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { QueryRunner } from "typeorm";
import { AlertEntity, RuleEntity, TransactionEntity } from "@regops/db";
import { AlertCloseCategory, AlertDto, AlertSeverity, AlertStatus, AuthUserContext, RuleScenarioType, TransactionDto } from "@regops/shared";
import { AuditService } from "../../audit/audit.service";
import { RequestMeta } from "../../users/users.service";
import { ALERT_EVENTS } from "../rules.events";

export interface AlertUpsertInput {
  tenantId: string;
  rule: RuleEntity;
  customerId: string;
  triggeringTransactionId: string | null;
  severity: AlertSeverity;
  title: string;
  evidence: Record<string, unknown>;
  dedupKey: string;
  firedAt: Date;
}

export interface AlertUpsertOutcome {
  alert: AlertEntity;
  wasInserted: boolean;
}

export interface AlertFilters {
  statuses?: AlertStatus[];
  severities?: AlertSeverity[];
  scenarioTypes?: RuleScenarioType[];
  ruleId?: string;
  customerId?: string;
  assignedTo?: string;
  firstFiredFrom?: string;
  firstFiredTo?: string;
  minFireCount?: number;
}

const SEVERITY_ORDER_SQL = `CASE severity WHEN 'CRITICAL' THEN 4 WHEN 'HIGH' THEN 3 WHEN 'MEDIUM' THEN 2 ELSE 1 END`;

@Injectable()
export class AlertsService {
  constructor(
    private readonly auditService: AuditService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Section 7.1/7.2: a single atomic UPSERT (INSERT ... ON CONFLICT ...
   * DO UPDATE ... RETURNING *, (xmax = 0) AS was_inserted) decides
   * create-vs-increment without a separate read-then-write race window —
   * `xmax = 0` is Postgres's own tell for "this row was just inserted by
   * this statement," not updated. The UPSERT itself only bumps
   * fire_count/last_fired_at; evidence (specifically merging
   * relatedTransactionIds without duplicates, Section 11.3) is merged in a
   * second statement on the conflict path — safe from the same race because
   * the UPSERT's row lock is already held by this transaction when that
   * second statement runs, so a concurrent evaluation for the same dedup_key
   * blocks on the first statement until this one commits.
   */
  async createOrIncrement(qr: QueryRunner, input: AlertUpsertInput): Promise<AlertUpsertOutcome> {
    const rows: Record<string, unknown>[] = await qr.manager.query(
      `INSERT INTO alert (
         tenant_id, rule_id, customer_id, triggering_transaction_id, scenario_type,
         severity, status, title, evidence, dedup_key, fire_count, first_fired_at, last_fired_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'NEW', $7, $8::jsonb, $9, 1, $10, $10)
       ON CONFLICT (tenant_id, dedup_key) WHERE status != 'CLOSED'
       DO UPDATE SET
         fire_count = alert.fire_count + 1,
         last_fired_at = EXCLUDED.last_fired_at
       RETURNING *, (xmax = 0) AS was_inserted`,
      [
        input.tenantId,
        input.rule.id,
        input.customerId,
        input.triggeringTransactionId,
        input.rule.scenarioType,
        input.severity,
        input.title,
        JSON.stringify(input.evidence),
        input.dedupKey,
        input.firedAt,
      ],
    );
    const row = rows[0];
    const wasInserted = row.was_inserted === true;

    if (!wasInserted) {
      const existingEvidence = (row.evidence as Record<string, unknown>) ?? {};
      const existingIds = Array.isArray(existingEvidence.relatedTransactionIds) ? (existingEvidence.relatedTransactionIds as string[]) : [];
      const newIds = Array.isArray(input.evidence.relatedTransactionIds) ? (input.evidence.relatedTransactionIds as string[]) : [];
      const mergedEvidence = {
        ...existingEvidence,
        ...input.evidence,
        relatedTransactionIds: Array.from(new Set([...existingIds, ...newIds])),
      };
      await qr.manager.query(`UPDATE alert SET evidence = $1::jsonb, updated_at = now() WHERE id = $2`, [
        JSON.stringify(mergedEvidence),
        row.id,
      ]);
      row.evidence = mergedEvidence;
    }

    const alert = this.mapRow(row);

    await this.auditService.record(qr, {
      tenantId: input.tenantId,
      userId: null,
      action: wasInserted ? "alert.create" : "alert.escalate",
      entityType: "alert",
      entityId: alert.id,
      afterState: wasInserted
        ? { ruleId: alert.ruleId, customerId: alert.customerId, scenarioType: alert.scenarioType, severity: alert.severity, dedupKey: alert.dedupKey }
        : { fireCount: alert.fireCount },
      ipAddress: null,
      userAgent: null,
    });

    return { alert, wasInserted };
  }

  async findAll(
    qr: QueryRunner,
    tenantId: string,
    filters: AlertFilters,
    page: number,
    limit: number,
  ): Promise<{ data: AlertDto[]; meta: { page: number; limit: number; total: number } }> {
    const qb = qr.manager.getRepository(AlertEntity).createQueryBuilder("alert").where("alert.tenant_id = :tenantId", { tenantId });

    if (filters.statuses?.length) qb.andWhere("alert.status IN (:...statuses)", { statuses: filters.statuses });
    if (filters.severities?.length) qb.andWhere("alert.severity IN (:...severities)", { severities: filters.severities });
    if (filters.scenarioTypes?.length) qb.andWhere("alert.scenario_type IN (:...scenarioTypes)", { scenarioTypes: filters.scenarioTypes });
    if (filters.ruleId) qb.andWhere("alert.rule_id = :ruleId", { ruleId: filters.ruleId });
    if (filters.customerId) qb.andWhere("alert.customer_id = :customerId", { customerId: filters.customerId });
    if (filters.assignedTo) qb.andWhere("alert.assigned_to = :assignedTo", { assignedTo: filters.assignedTo });
    if (filters.firstFiredFrom) qb.andWhere("alert.first_fired_at >= :from", { from: filters.firstFiredFrom });
    if (filters.firstFiredTo) qb.andWhere("alert.first_fired_at <= :to", { to: filters.firstFiredTo });
    if (filters.minFireCount) qb.andWhere("alert.fire_count >= :minFireCount", { minFireCount: filters.minFireCount });

    qb.orderBy(SEVERITY_ORDER_SQL, "DESC").addOrderBy("alert.first_fired_at", "DESC");
    qb.skip((page - 1) * limit).take(limit);

    const [rows, total] = await qb.getManyAndCount();
    return { data: rows.map((r) => this.toDto(r)), meta: { page, limit, total } };
  }

  async findOne(qr: QueryRunner, tenantId: string, id: string): Promise<AlertEntity> {
    const alert = await qr.manager.getRepository(AlertEntity).findOne({ where: { id, tenantId } });
    if (!alert) throw new NotFoundException({ code: "ALERT_NOT_FOUND", message: "Alert not found." });
    return alert;
  }

  async assign(
    qr: QueryRunner,
    tenantId: string,
    id: string,
    assignedTo: string,
    currentUser: AuthUserContext,
    meta: RequestMeta,
  ): Promise<AlertDto> {
    const alert = await this.findOne(qr, tenantId, id);
    if (alert.status === AlertStatus.CLOSED) {
      throw new BadRequestException({ code: "ALERT_CLOSED", message: "Cannot assign a closed alert." });
    }
    const beforeState = { status: alert.status, assignedTo: alert.assignedTo };
    const previousStatus = alert.status;
    alert.assignedTo = assignedTo;
    if (alert.status === AlertStatus.NEW) alert.status = AlertStatus.ASSIGNED;
    const saved = await qr.manager.getRepository(AlertEntity).save(alert);

    await this.auditService.record(qr, {
      tenantId,
      userId: currentUser.sub,
      action: "alert.assign",
      entityType: "alert",
      entityId: saved.id,
      beforeState,
      afterState: { status: saved.status, assignedTo: saved.assignedTo },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    // Backend Prompt 6: Case Management's auto-transition-to-UNDER_INVESTIGATION
    // trigger listens for this — only emit when the status genuinely changed.
    if (saved.status !== previousStatus) {
      this.eventEmitter.emit(ALERT_EVENTS.STATUS_CHANGED, {
        tenantId,
        alertId: saved.id,
        customerId: saved.customerId,
        previousStatus,
        newStatus: saved.status,
      });
    }

    return this.toDto(saved);
  }

  async close(
    qr: QueryRunner,
    tenantId: string,
    id: string,
    closeCategory: AlertCloseCategory,
    closureReason: string,
    currentUser: AuthUserContext,
    meta: RequestMeta,
  ): Promise<AlertDto> {
    const alert = await this.findOne(qr, tenantId, id);
    if (alert.status === AlertStatus.CLOSED) {
      throw new BadRequestException({ code: "ALERT_ALREADY_CLOSED", message: "Alert is already closed." });
    }
    const beforeState = { status: alert.status };
    const previousStatus = alert.status;
    alert.status = AlertStatus.CLOSED;
    alert.closedAt = new Date();
    alert.closedBy = currentUser.sub;
    alert.closeCategory = closeCategory;
    alert.closureReason = closureReason;
    const saved = await qr.manager.getRepository(AlertEntity).save(alert);

    await this.auditService.record(qr, {
      tenantId,
      userId: currentUser.sub,
      action: "alert.close",
      entityType: "alert",
      entityId: saved.id,
      beforeState,
      afterState: { status: saved.status, closeCategory: saved.closeCategory, closureReason: saved.closureReason },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    this.eventEmitter.emit(ALERT_EVENTS.CLOSED, {
      tenantId,
      alertId: saved.id,
      closedBy: currentUser.sub,
      closeCategory,
      previousStatus,
    });

    return this.toDto(saved);
  }

  async relatedTransactions(qr: QueryRunner, tenantId: string, id: string): Promise<TransactionDto[]> {
    const alert = await this.findOne(qr, tenantId, id);
    const ids = Array.isArray(alert.evidence.relatedTransactionIds) ? (alert.evidence.relatedTransactionIds as string[]) : [];
    if (ids.length === 0) return [];

    const rows = await qr.manager
      .getRepository(TransactionEntity)
      .createQueryBuilder("t")
      .where("t.tenant_id = :tenantId", { tenantId })
      .andWhere("t.id IN (:...ids)", { ids })
      .getMany();

    return rows.map((t) => ({
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

  toDto(alert: AlertEntity): AlertDto {
    return {
      id: alert.id,
      tenantId: alert.tenantId,
      ruleId: alert.ruleId,
      customerId: alert.customerId,
      triggeringTransactionId: alert.triggeringTransactionId,
      scenarioType: alert.scenarioType,
      severity: alert.severity,
      status: alert.status,
      title: alert.title,
      evidence: alert.evidence,
      dedupKey: alert.dedupKey,
      fireCount: alert.fireCount,
      firstFiredAt: alert.firstFiredAt.toISOString(),
      lastFiredAt: alert.lastFiredAt.toISOString(),
      assignedTo: alert.assignedTo,
      closedAt: alert.closedAt ? alert.closedAt.toISOString() : null,
      closedBy: alert.closedBy,
      closeCategory: alert.closeCategory,
      closureReason: alert.closureReason,
      createdAt: alert.createdAt.toISOString(),
      updatedAt: alert.updatedAt.toISOString(),
    };
  }

  private mapRow(row: Record<string, unknown>): AlertEntity {
    const alert = new AlertEntity();
    alert.id = row.id as string;
    alert.tenantId = row.tenant_id as string;
    alert.ruleId = row.rule_id as string;
    alert.customerId = row.customer_id as string;
    alert.triggeringTransactionId = row.triggering_transaction_id as string | null;
    alert.scenarioType = row.scenario_type as RuleScenarioType;
    alert.severity = row.severity as AlertSeverity;
    alert.status = row.status as AlertStatus;
    alert.title = row.title as string;
    alert.evidence = row.evidence as Record<string, unknown>;
    alert.dedupKey = row.dedup_key as string;
    alert.fireCount = Number(row.fire_count);
    alert.firstFiredAt = new Date(row.first_fired_at as string);
    alert.lastFiredAt = new Date(row.last_fired_at as string);
    alert.assignedTo = row.assigned_to as string | null;
    alert.closedAt = row.closed_at ? new Date(row.closed_at as string) : null;
    alert.closedBy = row.closed_by as string | null;
    alert.closeCategory = row.close_category as AlertCloseCategory | null;
    alert.closureReason = row.closure_reason as string | null;
    alert.createdAt = new Date(row.created_at as string);
    alert.updatedAt = new Date(row.updated_at as string);
    return alert;
  }
}
