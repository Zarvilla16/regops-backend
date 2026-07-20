import { BadRequestException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { QueryRunner } from "typeorm";
import { CustomerEntity, RuleEntity, TransactionEntity } from "@regops/db";
import { AuthUserContext, RuleDto } from "@regops/shared";
import { DEFAULT_RULE_CONFIGS, dispatchEvaluation, EvaluationContext, EvaluationResult } from "@regops/rules-engine";
import { AuditService } from "../audit/audit.service";
import { RequestMeta } from "../users/users.service";
import { EvaluatorFactsGatheringService } from "./facts/evaluator-facts-gathering.service";
import { detectLoosening } from "./loosening";
import { RULE_EVENTS } from "./rules.events";

@Injectable()
export class RulesService {
  constructor(
    private readonly auditService: AuditService,
    private readonly eventEmitter: EventEmitter2,
    private readonly factsGatheringService: EvaluatorFactsGatheringService,
  ) {}

  /** Idempotent — safe to call more than once for the same tenant (Section 5.4). */
  async seedDefaultsForTenant(qr: QueryRunner, tenantId: string): Promise<void> {
    const repo = qr.manager.getRepository(RuleEntity);
    for (const defaults of DEFAULT_RULE_CONFIGS) {
      const existing = await repo.findOne({ where: { tenantId, scenarioType: defaults.scenarioType } });
      if (existing) continue;
      await repo.save(
        repo.create({
          tenantId,
          name: defaults.name,
          scenarioType: defaults.scenarioType,
          description: defaults.description,
          config: defaults.config,
          severity: defaults.severity,
          action: defaults.action,
          isActive: true,
        }),
      );
    }
  }

  async findActiveForTenant(qr: QueryRunner, tenantId: string): Promise<RuleEntity[]> {
    return qr.manager.getRepository(RuleEntity).find({ where: { tenantId, isActive: true } });
  }

  async findAll(qr: QueryRunner, tenantId: string): Promise<RuleDto[]> {
    const rules = await qr.manager.getRepository(RuleEntity).find({ where: { tenantId }, order: { scenarioType: "ASC" } });
    return rules.map((r) => this.toDto(r));
  }

  async findOneEntity(qr: QueryRunner, tenantId: string, id: string): Promise<RuleEntity> {
    const rule = await qr.manager.getRepository(RuleEntity).findOne({ where: { id, tenantId } });
    if (!rule) throw new NotFoundException({ code: "RULE_NOT_FOUND", message: "Rule not found." });
    return rule;
  }

  async findOne(qr: QueryRunner, tenantId: string, id: string): Promise<RuleDto> {
    return this.toDto(await this.findOneEntity(qr, tenantId, id));
  }

  /**
   * PATCH /rules/:id (Section 9.2). Guardrails, in order:
   * - `isActive: false` requires a non-empty `reason` in the body.
   * - Any config change that reduces detection sensitivity (per
   *   loosening.ts's LOOSENS_ON_INCREASE table) requires
   *   `confirmedLoosening = true` (from the X-Confirm-Loosening header) —
   *   otherwise 422.
   * - Both the before/after config diff and the disable reason are recorded
   *   on the audit row.
   */
  async update(
    qr: QueryRunner,
    tenantId: string,
    id: string,
    dto: { config?: Record<string, unknown>; isActive?: boolean; reason?: string },
    confirmedLoosening: boolean,
    currentUser: AuthUserContext,
    meta: RequestMeta,
  ): Promise<RuleDto> {
    const rule = await this.findOneEntity(qr, tenantId, id);

    if (dto.isActive === false && rule.isActive !== false && !dto.reason?.trim()) {
      throw new BadRequestException({
        code: "DISABLE_REASON_REQUIRED",
        message: "A reason is required when disabling a rule.",
      });
    }

    const beforeState = { config: rule.config, isActive: rule.isActive };
    let isLoosening = false;

    if (dto.config) {
      const { isLoosening: loosening, changedKeys } = detectLoosening(rule.config, dto.config);
      isLoosening = loosening;
      if (isLoosening && !confirmedLoosening) {
        throw new UnprocessableEntityException({
          code: "LOOSENING_CONFIRMATION_REQUIRED",
          message: "This change reduces detection sensitivity. Retry with X-Confirm-Loosening: true to confirm.",
          details: { changedKeys },
        });
      }
      rule.config = { ...rule.config, ...dto.config };
    }
    if (dto.isActive !== undefined) rule.isActive = dto.isActive;

    const saved = await qr.manager.getRepository(RuleEntity).save(rule);

    await this.auditService.record(qr, {
      tenantId,
      userId: currentUser.sub,
      action: dto.isActive === false ? "rule.disable" : "rule.update",
      entityType: "rule",
      entityId: saved.id,
      beforeState,
      afterState: { config: saved.config, isActive: saved.isActive, reason: dto.reason ?? null },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    this.eventEmitter.emit(RULE_EVENTS.UPDATED, {
      tenantId,
      ruleId: saved.id,
      scenarioType: saved.scenarioType,
      isLoosening,
      updatedBy: currentUser.sub,
    });

    return this.toDto(saved);
  }

  /** POST /rules/:id/test (Section 9): dry-run — evaluates the rule's
   * CURRENT config against an existing transaction, persisting nothing. */
  async testRule(qr: QueryRunner, tenantId: string, id: string, transactionId: string): Promise<EvaluationResult> {
    const rule = await this.findOneEntity(qr, tenantId, id);
    const transaction = await qr.manager.getRepository(TransactionEntity).findOne({ where: { tenantId, id: transactionId } });
    if (!transaction) throw new NotFoundException({ code: "TRANSACTION_NOT_FOUND", message: "Transaction not found." });
    const customer = await qr.manager.getRepository(CustomerEntity).findOne({ where: { tenantId, id: transaction.customerId } });
    if (!customer) throw new NotFoundException({ code: "CUSTOMER_NOT_FOUND", message: "Customer not found." });

    const ctx: EvaluationContext = {
      tenantId,
      now: new Date(),
      transaction: {
        id: transaction.id,
        customerId: transaction.customerId,
        amount: transaction.amount,
        currency: transaction.currency,
        type: transaction.type,
        channel: transaction.channel,
        counterpartyAccount: transaction.counterpartyAccount,
        counterpartyBank: transaction.counterpartyBank,
        counterpartyName: transaction.counterpartyName,
        counterpartyCustomerId: transaction.counterpartyCustomerId,
        occurredAt: transaction.occurredAt,
      },
      customer: {
        id: customer.id,
        fullName: customer.fullName,
        customerType: customer.customerType,
        isPep: customer.isPep,
        isSanctioned: customer.isSanctioned,
        onboardedAt: customer.onboardedAt,
      },
    };

    const facts = await this.factsGatheringService.gather(qr, ctx, rule);
    return dispatchEvaluation(ctx, rule.config, facts);
  }

  toDto(rule: RuleEntity): RuleDto {
    return {
      id: rule.id,
      tenantId: rule.tenantId,
      name: rule.name,
      scenarioType: rule.scenarioType,
      description: rule.description,
      config: rule.config,
      severity: rule.severity,
      action: rule.action,
      isActive: rule.isActive,
      createdAt: rule.createdAt.toISOString(),
      updatedAt: rule.updatedAt.toISOString(),
    };
  }
}
