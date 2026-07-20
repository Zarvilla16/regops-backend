import { Injectable, NotFoundException, Optional } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { QueryRunner } from "typeorm";
import { CustomerEntity, RiskScoreHistoryEntity } from "@regops/db";
import { AuthUserContext, RiskFactorType, RiskScoreHistoryDto, ScoreTrigger } from "@regops/shared";
import {
  aggregateRiskScore,
  createFactorRegistry,
  RiskFactorContext,
  runFactors,
  TransactionVelocityAdapter,
} from "@regops/risk-engine";
import { AuditService } from "../audit/audit.service";
import { RiskFactorConfigService } from "./config/risk-factor-config.service";
import { VelocityAdapterService } from "../transactions/velocity-adapter.service";

export interface CustomerRiskChangedEvent {
  tenantId: string;
  customerId: string;
  previousLevel: string;
  newLevel: string;
  previousScore: number;
  newScore: number;
  trigger: ScoreTrigger;
  riskScoreHistoryId: string;
  occurredAt: Date;
}

@Injectable()
export class RiskService {
  constructor(
    private readonly riskFactorConfigService: RiskFactorConfigService,
    private readonly auditService: AuditService,
    private readonly eventEmitter: EventEmitter2,
    /** Optional — same @Optional() contract packages/risk-engine's
     * TransactionVelocityFactor scaffold was built against (Backend Prompt
     * 2). Absent only if TransactionsModule somehow isn't loaded; present in
     * every real deployment since RiskModule imports TransactionsModule. */
    @Optional() private readonly velocityAdapterService?: VelocityAdapterService,
  ) {}

  /**
   * risk-engine's TransactionVelocityAdapter.getStats(customerId) takes only
   * a customerId — it has no way to receive this request's QueryRunner,
   * tenantId, or the tenant's tuned TRANSACTION_VELOCITY config. Rather than
   * widen that interface (and force every other, DB-agnostic factor
   * implementation to care about it), build a one-shot closure adapter here
   * that already has all three in scope, and hand THAT to createFactorRegistry
   * for this single calculation.
   */
  private buildTransactionVelocityAdapter(
    queryRunner: QueryRunner,
    tenantId: string,
    config: Record<string, unknown> | undefined,
    now: Date,
  ): TransactionVelocityAdapter | undefined {
    if (!this.velocityAdapterService) return undefined;
    const service = this.velocityAdapterService;
    return {
      getStats: (customerId: string) => service.getStats(queryRunner, tenantId, customerId, config ?? {}, now),
    };
  }

  toDto(history: RiskScoreHistoryEntity): RiskScoreHistoryDto {
    return {
      id: history.id,
      tenantId: history.tenantId,
      customerId: history.customerId,
      score: history.score,
      level: history.level,
      factors: history.factors,
      trigger: history.trigger,
      previousScore: history.previousScore,
      previousLevel: history.previousLevel,
      calculatedAt: history.calculatedAt.toISOString(),
      calculatedBy: history.calculatedBy,
    };
  }

  /**
   * Runs every registered factor, aggregates + bands the result, writes a
   * new RiskScoreHistory row (always — even when the score is unchanged,
   * that's audit history, not a bug), updates the customer's cached
   * risk_score/risk_level, and emits customer.risk_changed if the level
   * actually transitioned. Does NOT write an audit_log row itself — INITIAL
   * and CUSTOMER_UPDATED triggers are a side effect of an already-audited
   * customer.create/customer.update; MANUAL and SCHEDULED triggers get
   * their own dedicated audit entry from the caller (see rescoreManual /
   * rescoreScheduled below) so the action is independently visible in the
   * trail, not just folded into "customer.update".
   *
   * Deliberately does not catch errors from individual factor calculators —
   * a thrown error must fail the whole calculation, not be silently
   * skipped (a wrong score is worse than a visible failure).
   */
  async calculateAndPersist(
    queryRunner: QueryRunner,
    customer: CustomerEntity,
    trigger: ScoreTrigger,
    calculatedBy: string | null,
  ): Promise<RiskScoreHistoryEntity> {
    const configs = await this.riskFactorConfigService.findActiveForTenant(queryRunner, customer.tenantId);
    const configByType = new Map(configs.map((c) => [c.factorType, c]));
    const now = new Date();

    const velocityAdapter = this.buildTransactionVelocityAdapter(
      queryRunner,
      customer.tenantId,
      configByType.get(RiskFactorType.TRANSACTION_VELOCITY)?.config,
      now,
    );

    const results = await runFactors(createFactorRegistry(velocityAdapter), (factor) => {
      const config = configByType.get(factor.type);
      if (!config) return null; // no tenant config row for this factor type (shouldn't happen once seeding has run)

      const ctx: RiskFactorContext = {
        customerId: customer.id,
        customer: {
          customerType: customer.customerType,
          occupation: customer.occupation,
          country: customer.country,
          nationality: customer.nationality,
          kycTier: customer.kycTier,
          isPep: customer.isPep,
          isSanctioned: customer.isSanctioned,
        },
        tenant: { id: customer.tenantId },
        config: {
          factorType: config.factorType,
          weight: config.weight,
          config: config.config,
          isActive: config.isActive,
        },
        now,
      };
      return ctx;
    });

    const { score, level, factors } = aggregateRiskScore(results, customer);
    const previousScore = customer.riskScore;
    const previousLevel = customer.riskLevel;

    const historyRepo = queryRunner.manager.getRepository(RiskScoreHistoryEntity);
    const history = await historyRepo.save(
      historyRepo.create({
        tenantId: customer.tenantId,
        customerId: customer.id,
        score,
        level,
        factors,
        trigger,
        previousScore,
        previousLevel,
        calculatedAt: now,
        calculatedBy: trigger === ScoreTrigger.MANUAL ? calculatedBy : null,
      }),
    );

    await queryRunner.manager
      .getRepository(CustomerEntity)
      .update({ id: customer.id }, { riskScore: score, riskLevel: level, lastRiskCalculatedAt: now });

    if (previousLevel !== level) {
      this.eventEmitter.emit("customer.risk_changed", {
        tenantId: customer.tenantId,
        customerId: customer.id,
        previousLevel,
        newLevel: level,
        previousScore,
        newScore: score,
        trigger,
        riskScoreHistoryId: history.id,
        occurredAt: now,
      } satisfies CustomerRiskChangedEvent);
    }

    return history;
  }

  /** POST /customers/:id/rescore — user-initiated, gets its own audit entry. */
  async rescoreManual(
    queryRunner: QueryRunner,
    customer: CustomerEntity,
    currentUser: AuthUserContext,
  ): Promise<RiskScoreHistoryDto> {
    const history = await this.calculateAndPersist(queryRunner, customer, ScoreTrigger.MANUAL, currentUser.sub);

    await this.auditService.record(queryRunner, {
      tenantId: customer.tenantId,
      userId: currentUser.sub,
      action: "risk.rescore.manual",
      entityType: "customer",
      entityId: customer.id,
      afterState: { riskScore: history.score, riskLevel: history.level },
      ipAddress: null,
      userAgent: null,
    });

    return this.toDto(history);
  }

  /** System-initiated (see RescoreSchedulerService) — user_id is NULL, gets its own audit entry. */
  async rescoreScheduled(queryRunner: QueryRunner, customer: CustomerEntity): Promise<RiskScoreHistoryEntity> {
    const history = await this.calculateAndPersist(queryRunner, customer, ScoreTrigger.SCHEDULED, null);

    await this.auditService.record(queryRunner, {
      tenantId: customer.tenantId,
      userId: null,
      action: "risk.rescore.scheduled",
      entityType: "customer",
      entityId: customer.id,
      afterState: { riskScore: history.score, riskLevel: history.level },
      ipAddress: null,
      userAgent: null,
    });

    return history;
  }

  /** System-initiated by TransactionListener's debounced transaction.ingested
   * handler (Backend Prompt 4, Section 9.4) — same shape as rescoreScheduled,
   * own audit action so it's independently visible in the trail. */
  async rescoreEventTriggered(queryRunner: QueryRunner, customer: CustomerEntity): Promise<RiskScoreHistoryEntity> {
    const history = await this.calculateAndPersist(queryRunner, customer, ScoreTrigger.TRANSACTION_ACTIVITY, null);

    await this.auditService.record(queryRunner, {
      tenantId: customer.tenantId,
      userId: null,
      action: "risk.rescore.transaction_activity",
      entityType: "customer",
      entityId: customer.id,
      afterState: { riskScore: history.score, riskLevel: history.level },
      ipAddress: null,
      userAgent: null,
    });

    return history;
  }

  async findHistoryForCustomer(
    queryRunner: QueryRunner,
    tenantId: string,
    customerId: string,
    page: number,
    limit: number,
  ): Promise<{ data: RiskScoreHistoryDto[]; total: number }> {
    const customer = await queryRunner.manager
      .getRepository(CustomerEntity)
      .findOne({ where: { tenantId, id: customerId } });
    if (!customer) {
      throw new NotFoundException({ code: "CUSTOMER_NOT_FOUND", message: "Customer not found." });
    }

    const [rows, total] = await queryRunner.manager.getRepository(RiskScoreHistoryEntity).findAndCount({
      where: { tenantId, customerId },
      order: { calculatedAt: "DESC" },
      skip: (page - 1) * limit,
      take: limit,
    });

    return { data: rows.map((r) => this.toDto(r)), total };
  }
}
