import { randomUUID } from "crypto";
import { Injectable, Logger } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { DataSource, QueryRunner } from "typeorm";
import { CustomerEntity, RuleEntity, RuleEvaluationEntity, TransactionEntity } from "@regops/db";
import { AlertSeverity, RuleEvaluationResultStatus } from "@regops/shared";
import { dispatchEvaluation, EvaluationContext, EvaluatorCustomer, EvaluatorTransaction } from "@regops/rules-engine";
import { EvaluatorFactsGatheringService } from "../facts/evaluator-facts-gathering.service";
import { AlertsService, AlertUpsertOutcome } from "../alerts/alerts.service";
import { ALERT_EVENTS } from "../rules.events";

/**
 * Section 5.2's orchestration, adapted from the spec's `@Processor`/
 * `WorkerHost` NestJS-BullMQ pseudocode to this codebase's own hand-rolled
 * Queue/Worker convention (see RuleEvaluationConsumerService). One Rule
 * evaluation at a time, sequentially, per transaction — the spec's
 * `Promise.allSettled` "one slow rule doesn't block others" intent is
 * preserved by wrapping each rule's evaluation in its own try/catch so one
 * throwing evaluator never prevents the rest from running or their
 * RuleEvaluation rows from being written (Section 11.2's required test).
 */
@Injectable()
export class RuleEvaluationOrchestratorService {
  private readonly logger = new Logger(RuleEvaluationOrchestratorService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly factsGatheringService: EvaluatorFactsGatheringService,
    private readonly alertsService: AlertsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async evaluateTransaction(tenantId: string, transactionId: string): Promise<void> {
    await this.withTenantContext(tenantId, async (qr) => {
      const txnRow = await qr.manager.getRepository(TransactionEntity).findOne({ where: { tenantId, id: transactionId } });
      if (!txnRow) {
        this.logger.warn(`transaction ${transactionId} not found for tenant ${tenantId} (stale/replayed event) — skipping`);
        return;
      }
      const customer = await qr.manager.getRepository(CustomerEntity).findOne({ where: { tenantId, id: txnRow.customerId } });
      if (!customer) {
        this.logger.warn(`customer ${txnRow.customerId} not found for transaction ${transactionId} — skipping`);
        return;
      }

      const activeRules = await qr.manager.getRepository(RuleEntity).find({ where: { tenantId, isActive: true } });

      const ctx: EvaluationContext = {
        tenantId,
        now: new Date(),
        transaction: this.toEvaluatorTransaction(txnRow),
        customer: this.toEvaluatorCustomer(customer),
      };

      // Deliberately sequential (not Promise.allSettled) — every evaluator
      // shares the same request-scoped QueryRunner/transaction, and
      // concurrent queries on one TypeORM QueryRunner are not safe. Each
      // rule's own try/catch (see evaluateOne) still guarantees one
      // throwing/slow evaluator never blocks or skips the others' RuleEvaluation rows.
      for (const rule of activeRules) {
        await this.evaluateOne(qr, ctx, rule);
      }
    });
  }

  private async evaluateOne(qr: QueryRunner, ctx: EvaluationContext, rule: RuleEntity): Promise<void> {
    const startedAt = Date.now();
    try {
      const facts = await this.factsGatheringService.gather(qr, ctx, rule);
      const result = dispatchEvaluation(ctx, rule.config, facts);
      const durationMs = Date.now() - startedAt;

      let alertId: string | null = null;
      if (result.fired && result.evidence) {
        const outcome = await this.alertsService.createOrIncrement(qr, {
          tenantId: ctx.tenantId,
          rule,
          customerId: ctx.customer.id,
          triggeringTransactionId: ctx.transaction.id,
          severity: result.severity ?? rule.severity,
          title: result.evidence.summary,
          evidence: { ...result.evidence.facts, relatedTransactionIds: result.evidence.relatedTransactionIds ?? [] },
          dedupKey: result.dedupKey ?? `${rule.scenarioType}:${ctx.customer.id}:${ctx.transaction.id}`,
          firedAt: ctx.now,
        });
        alertId = outcome.alert.id;
        this.emitAlertEvents(ctx.tenantId, outcome);
      }

      const status = result.fired ? RuleEvaluationResultStatus.FIRED : RuleEvaluationResultStatus.NOT_FIRED;
      await this.recordEvaluation(qr, ctx, rule, durationMs, status, alertId, null);
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      this.logger.error(`Rule ${rule.id} (${rule.scenarioType}) failed evaluating transaction ${ctx.transaction.id}`, err as Error);
      await this.recordEvaluation(qr, ctx, rule, durationMs, RuleEvaluationResultStatus.ERROR, null, (err as Error).message);
    }
  }

  private async recordEvaluation(
    qr: QueryRunner,
    ctx: EvaluationContext,
    rule: RuleEntity,
    durationMs: number,
    result: RuleEvaluationResultStatus,
    alertId: string | null,
    errorMessage: string | null,
  ): Promise<void> {
    const repo = qr.manager.getRepository(RuleEvaluationEntity);
    await repo.save(
      repo.create({
        id: randomUUID(),
        tenantId: ctx.tenantId,
        ruleId: rule.id,
        transactionId: ctx.transaction.id,
        evaluatedAt: ctx.now,
        durationMs,
        result,
        alertId,
        errorMessage,
      }),
    );
  }

  private emitAlertEvents(tenantId: string, outcome: AlertUpsertOutcome): void {
    const { alert, wasInserted } = outcome;
    if (wasInserted) {
      this.eventEmitter.emit(ALERT_EVENTS.CREATED, {
        tenantId,
        alertId: alert.id,
        ruleId: alert.ruleId,
        customerId: alert.customerId,
        scenarioType: alert.scenarioType,
        severity: alert.severity,
      });
      if (alert.severity === AlertSeverity.CRITICAL) {
        this.eventEmitter.emit(ALERT_EVENTS.CRITICAL_FIRED, {
          tenantId,
          alertId: alert.id,
          ruleId: alert.ruleId,
          customerId: alert.customerId,
          scenarioType: alert.scenarioType,
        });
      }
    } else {
      this.eventEmitter.emit(ALERT_EVENTS.ESCALATED, {
        tenantId,
        alertId: alert.id,
        ruleId: alert.ruleId,
        customerId: alert.customerId,
        fireCount: alert.fireCount,
      });
    }
  }

  private toEvaluatorTransaction(txn: TransactionEntity): EvaluatorTransaction {
    return {
      id: txn.id,
      customerId: txn.customerId,
      amount: txn.amount,
      currency: txn.currency,
      type: txn.type,
      channel: txn.channel,
      counterpartyAccount: txn.counterpartyAccount,
      counterpartyBank: txn.counterpartyBank,
      counterpartyName: txn.counterpartyName,
      counterpartyCustomerId: txn.counterpartyCustomerId,
      occurredAt: txn.occurredAt,
    };
  }

  private toEvaluatorCustomer(customer: CustomerEntity): EvaluatorCustomer {
    return {
      id: customer.id,
      fullName: customer.fullName,
      customerType: customer.customerType,
      isPep: customer.isPep,
      isSanctioned: customer.isSanctioned,
      onboardedAt: customer.onboardedAt,
    };
  }

  /** Same shape as RiskModule's TransactionListener.withTenantContext — a
   * fresh QueryRunner scoped to exactly this event's tenant, never
   * app.bypass_rls, since this runs outside any HTTP request's own connection. */
  private async withTenantContext<T>(tenantId: string, fn: (qr: QueryRunner) => Promise<T>): Promise<T> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await qr.query(
        `SELECT set_config('app.current_tenant_id', $1, true), set_config('app.bypass_rls', 'false', true)`,
        [tenantId],
      );
      const result = await fn(qr);
      await qr.commitTransaction();
      return result;
    } catch (err) {
      if (qr.isTransactionActive) {
        await qr.rollbackTransaction();
      }
      throw err;
    } finally {
      await qr.release();
    }
  }
}
