import { randomUUID } from "crypto";
import { DataSource, QueryRunner } from "typeorm";
import type { RedisClient } from "bullmq";
import { AuditLogEntity, CustomerEntity, RuleEntity, RuleEvaluationEntity, TransactionEntity } from "@regops/db";
import {
  AlertSeverity,
  RuleEvaluationAlertOutcome,
  RuleEvaluationJobResult,
  RuleEvaluationResultStatus,
  RuleScenarioType,
} from "@regops/shared";
import {
  dispatchEvaluation,
  EvaluationContext,
  EvaluatorCustomer,
  EvaluatorFacts,
  EvaluatorTransaction,
} from "@regops/rules-engine";
import { fetchRecentCashTransactions, fetchRecentCredits, fetchVelocityRawStats } from "./rule-facts";
import { resolveCounterpartyScreening } from "./counterparty-screening";

/** Minimal equivalent of apps/api's AuditService.record() — same shape as
 * this app's other worker-side duplicates (apply-confirmed-match.ts,
 * screening-check-runner.ts's own recordAudit), no NestJS DI container to
 * inject a real one from here. */
async function recordAudit(
  qr: QueryRunner,
  params: { tenantId: string; action: string; entityType: string; entityId: string; afterState: Record<string, unknown> },
): Promise<void> {
  const repo = qr.manager.getRepository(AuditLogEntity);
  await repo.save(
    repo.create({
      tenantId: params.tenantId,
      userId: null,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      beforeState: null,
      afterState: params.afterState,
      ipAddress: null,
      userAgent: null,
    }),
  );
}

interface AlertUpsertResult {
  id: string;
  ruleId: string;
  customerId: string;
  scenarioType: RuleScenarioType;
  severity: AlertSeverity;
  fireCount: number;
  wasInserted: boolean;
}

/** Plain-function equivalent of apps/api's AlertsService.createOrIncrement —
 * same atomic UPSERT (INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING *,
 * (xmax = 0) AS was_inserted) and the same second-statement evidence merge
 * on the conflict path, see that file's docblock for the full race-safety
 * rationale. */
async function createOrIncrementAlert(
  qr: QueryRunner,
  input: {
    tenantId: string;
    rule: RuleEntity;
    customerId: string;
    triggeringTransactionId: string | null;
    severity: AlertSeverity;
    title: string;
    evidence: Record<string, unknown>;
    dedupKey: string;
    firedAt: Date;
  },
): Promise<AlertUpsertResult> {
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

  let evidence = row.evidence as Record<string, unknown>;
  if (!wasInserted) {
    const existingIds = Array.isArray(evidence.relatedTransactionIds) ? (evidence.relatedTransactionIds as string[]) : [];
    const newIds = Array.isArray(input.evidence.relatedTransactionIds) ? (input.evidence.relatedTransactionIds as string[]) : [];
    evidence = {
      ...evidence,
      ...input.evidence,
      relatedTransactionIds: Array.from(new Set([...existingIds, ...newIds])),
    };
    await qr.manager.query(`UPDATE alert SET evidence = $1::jsonb, updated_at = now() WHERE id = $2`, [
      JSON.stringify(evidence),
      row.id,
    ]);
  }

  // row.fire_count is already the POST-increment value (RETURNING reads the
  // row after the UPDATE ... fire_count = alert.fire_count + 1 already
  // applied) — no further +1 here, same as AlertsService.createOrIncrement's
  // own mapRow(row).fireCount.
  await recordAudit(qr, {
    tenantId: input.tenantId,
    action: wasInserted ? "alert.create" : "alert.escalate",
    entityType: "alert",
    entityId: row.id as string,
    afterState: wasInserted
      ? { ruleId: input.rule.id, customerId: input.customerId, scenarioType: input.rule.scenarioType, severity: input.severity, dedupKey: input.dedupKey }
      : { fireCount: Number(row.fire_count) },
  });

  return {
    id: row.id as string,
    ruleId: input.rule.id,
    customerId: input.customerId,
    scenarioType: input.rule.scenarioType,
    severity: input.severity,
    fireCount: Number(row.fire_count),
    wasInserted,
  };
}

/** Plain-function equivalent of apps/api's EvaluatorFactsGatheringService —
 * same switch-dispatch mapping a Rule's scenario_type to the DB queries/
 * screening calls its evaluator needs. */
async function gatherFacts(
  qr: QueryRunner,
  redisClient: RedisClient,
  ctx: EvaluationContext,
  rule: RuleEntity,
): Promise<EvaluatorFacts> {
  switch (rule.scenarioType) {
    case RuleScenarioType.LARGE_CASH:
      return { scenarioType: rule.scenarioType };
    case RuleScenarioType.STRUCTURING: {
      const windowHours = Number(rule.config.windowHours ?? 24);
      const recentCashTxns = await fetchRecentCashTransactions(qr, ctx.tenantId, ctx.customer.id, ctx.transaction, windowHours);
      return { scenarioType: rule.scenarioType, recentCashTxns };
    }
    case RuleScenarioType.RAPID_INFLOW_OUTFLOW: {
      const windowMinutes = Number(rule.config.windowMinutes ?? 60);
      const recentCredits = await fetchRecentCredits(qr, ctx.tenantId, ctx.customer.id, ctx.transaction, windowMinutes);
      return { scenarioType: rule.scenarioType, recentCredits };
    }
    case RuleScenarioType.HIGH_RISK_COUNTERPARTY: {
      const screening = await resolveCounterpartyScreening(qr, redisClient, ctx.tenantId, ctx.transaction, rule.config);
      return { scenarioType: rule.scenarioType, screening };
    }
    case RuleScenarioType.VELOCITY_SPIKE: {
      const historyDays = Number(rule.config.historyDays ?? 30);
      const stats = await fetchVelocityRawStats(qr, ctx.tenantId, ctx.customer.id, historyDays, ctx.now, ctx.customer.onboardedAt);
      return { scenarioType: rule.scenarioType, stats };
    }
  }
}

function toEvaluatorTransaction(txn: TransactionEntity): EvaluatorTransaction {
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

function toEvaluatorCustomer(customer: CustomerEntity): EvaluatorCustomer {
  return {
    id: customer.id,
    fullName: customer.fullName,
    customerType: customer.customerType,
    isPep: customer.isPep,
    isSanctioned: customer.isSanctioned,
    onboardedAt: customer.onboardedAt,
  };
}

async function withTenantContext<T>(dataSource: DataSource, tenantId: string, fn: (qr: QueryRunner) => Promise<T>): Promise<T> {
  const qr = dataSource.createQueryRunner();
  await qr.connect();
  await qr.startTransaction();
  try {
    await qr.query(`SELECT set_config('app.current_tenant_id', $1, true), set_config('app.bypass_rls', 'false', true)`, [tenantId]);
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

/**
 * Plain-function equivalent of apps/api's RuleEvaluationOrchestratorService —
 * the real per-transaction, per-rule evaluation loop, moved here from
 * apps/api to match every other worker-side job in this codebase (see
 * HANDOFF.md's Prompt 5 deviations for the history). Every rule wrapped in
 * its own try/catch so one throwing/slow evaluator never blocks or skips the
 * others' RuleEvaluation rows — same guarantee as the apps/api original.
 * Deliberately sequential (not Promise.allSettled): every evaluator shares
 * the same request-scoped QueryRunner/transaction, and concurrent queries on
 * one TypeORM QueryRunner are not safe.
 *
 * Returns the fired/escalated alerts instead of emitting EventEmitter2
 * events directly (apps/worker has none) — RuleEvaluationQueueService's
 * QueueEvents bridge re-derives and emits ALERT_EVENTS.CREATED/
 * CRITICAL_FIRED/ESCALATED from this return value once it observes the job
 * complete, same pattern as AsyncScreeningQueueService/RescreenQueueService.
 */
export async function evaluateTransaction(
  dataSource: DataSource,
  redisClient: RedisClient,
  tenantId: string,
  transactionId: string,
): Promise<RuleEvaluationJobResult> {
  return withTenantContext(dataSource, tenantId, async (qr) => {
    const alerts: RuleEvaluationAlertOutcome[] = [];

    const txnRow = await qr.manager.getRepository(TransactionEntity).findOne({ where: { tenantId, id: transactionId } });
    if (!txnRow) {
      console.warn(`[rules] transaction ${transactionId} not found for tenant ${tenantId} (stale/replayed event) — skipping`);
      return { tenantId, transactionId, alerts };
    }
    const customer = await qr.manager.getRepository(CustomerEntity).findOne({ where: { tenantId, id: txnRow.customerId } });
    if (!customer) {
      console.warn(`[rules] customer ${txnRow.customerId} not found for transaction ${transactionId} — skipping`);
      return { tenantId, transactionId, alerts };
    }

    const activeRules = await qr.manager.getRepository(RuleEntity).find({ where: { tenantId, isActive: true } });

    const ctx: EvaluationContext = {
      tenantId,
      now: new Date(),
      transaction: toEvaluatorTransaction(txnRow),
      customer: toEvaluatorCustomer(customer),
    };

    for (const rule of activeRules) {
      const startedAt = Date.now();
      try {
        const facts = await gatherFacts(qr, redisClient, ctx, rule);
        const result = dispatchEvaluation(ctx, rule.config, facts);
        const durationMs = Date.now() - startedAt;

        let alertId: string | null = null;
        if (result.fired && result.evidence) {
          const outcome = await createOrIncrementAlert(qr, {
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
          alertId = outcome.id;
          alerts.push({
            alertId: outcome.id,
            ruleId: outcome.ruleId,
            customerId: outcome.customerId,
            scenarioType: outcome.scenarioType,
            severity: outcome.severity,
            wasInserted: outcome.wasInserted,
            fireCount: outcome.fireCount,
          });
        }

        const status = result.fired ? RuleEvaluationResultStatus.FIRED : RuleEvaluationResultStatus.NOT_FIRED;
        await recordEvaluation(qr, ctx, rule, durationMs, status, alertId, null);
      } catch (err) {
        const durationMs = Date.now() - startedAt;
        console.error(`[rules] Rule ${rule.id} (${rule.scenarioType}) failed evaluating transaction ${ctx.transaction.id}`, err);
        await recordEvaluation(qr, ctx, rule, durationMs, RuleEvaluationResultStatus.ERROR, null, (err as Error).message);
      }
    }

    return { tenantId, transactionId, alerts };
  });
}

async function recordEvaluation(
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
