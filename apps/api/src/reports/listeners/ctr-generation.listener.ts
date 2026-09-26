import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { DataSource, QueryRunner } from "typeorm";
import { CustomerEntity, RuleEntity, TransactionEntity } from "@regops/db";
import { CustomerType, RuleScenarioType } from "@regops/shared";
import { DEFAULT_RULE_CONFIGS, evaluateLargeCash, LargeCashConfig } from "@regops/rules-engine";
import { TransactionIngestedEvent } from "../../transactions/transactions.events";
import { ReportsService } from "../reports.service";

/**
 * Backend Prompt 7, Sections 2.2/3.3: fully automatic CTR generation off
 * `transaction.ingested`.
 *
 * "Is this transaction reportable?" is answered by the Large Cash Threshold
 * rule's own evaluator (`evaluateLargeCash` from @regops/rules-engine), fed
 * the tenant's own LARGE_CASH rule config — the same function and the same
 * config row the rule-evaluation worker uses, so the two cannot drift apart
 * (no second copy of the threshold, no second copy of the CASH/NGN/PEP-vs-
 * corporate logic). The threshold that actually applied comes back in the
 * evaluator's own evidence (`facts.thresholdApplied`).
 *
 * Consequences of reuse, deliberately accepted:
 *  - The rule's config is honoured even if the rule is currently deactivated
 *    (isActive only gates *alerting*; a CTR is a mandatory filing). If the
 *    tenant has no LARGE_CASH rule row at all, DEFAULT_RULE_CONFIGS is used.
 *  - Whatever the evaluator excludes (non-NGN, excludedChannels,
 *    applyToCredit/applyToDebit = false) is also not CTR-eligible.
 *
 * A zero-DB pre-filter (couldEverQualify) keeps non-cash events from opening a
 * connection at all — see its docblock for why that is not a second copy of the logic.
 *
 * Idempotency: ReportsService.generateCtr() is INSERT ... ON CONFLICT DO
 * NOTHING against the partial unique index on report.transaction_id.
 *
 * Known gap (HANDOFF.md): if this listener never runs for an event (API
 * process down when the ingestion bridge fires it), no CTR is generated and
 * nothing reconciles it later.
 */
@Injectable()
export class CtrGenerationListener {
  private readonly logger = new Logger(CtrGenerationListener.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly reportsService: ReportsService,
  ) {}

  /**
   * Zero-DB pre-filter so the (very common) non-cash ingestion event never opens a connection/transaction.
   * It does NOT re-implement "is this reportable": it asks evaluateLargeCash itself whether this
   * channel/currency/type could qualify at all, by evaluating with thresholds of 0 and an
   * unboundedly large amount. That is a strict superset of the real check (the tenant's
   * excludedChannels/apply-to-credit/debit flags, the real threshold and the customer type are only
   * applied by the full evaluation afterwards), and because the gating comes from the evaluator
   * itself it cannot drift from it.
   */
  private couldEverQualify(event: TransactionIngestedEvent): boolean {
    const result = evaluateLargeCash(
      {
        tenantId: event.tenantId,
        transaction: {
          id: event.transactionId,
          customerId: event.customerId,
          amount: String(Number.MAX_SAFE_INTEGER),
          currency: event.currency,
          type: event.type,
          channel: event.channel,
          counterpartyAccount: null,
          counterpartyBank: null,
          counterpartyName: null,
          counterpartyCustomerId: null,
          occurredAt: new Date(event.occurredAt),
        },
        customer: { id: event.customerId, fullName: "", customerType: CustomerType.INDIVIDUAL, isPep: false, isSanctioned: false, onboardedAt: new Date(0) },
        now: new Date(),
      },
      { thresholdIndividual: 0, thresholdCorporate: 0 },
    );
    return result.fired;
  }

  @OnEvent("transaction.ingested")
  async onTransactionIngested(event: TransactionIngestedEvent): Promise<void> {
    // A malformed event must never reach findOne(): TypeORM drops an `undefined` where-clause value entirely,
    // which would match an arbitrary transaction of the tenant.
    if (!event.transactionId || !event.tenantId) return;
    if (!this.couldEverQualify(event)) return;
    try {
      await this.withTenantContext(event.tenantId, (qr) => this.generateIfReportable(qr, event.tenantId, event.transactionId));
    } catch (err) {
      this.logger.error(`Failed to evaluate/generate CTR for transaction ${event.transactionId}`, err as Error);
    }
  }

  /** Returns the new report id, or null when the transaction is not reportable or a CTR already exists. */
  async generateIfReportable(qr: QueryRunner, tenantId: string, transactionId: string): Promise<string | null> {
    const transaction = await qr.manager.getRepository(TransactionEntity).findOne({ where: { id: transactionId, tenantId } });
    if (!transaction) {
      this.logger.warn(`CTR check: transaction ${transactionId} not found for tenant ${tenantId}`);
      return null;
    }
    const customer = await qr.manager.getRepository(CustomerEntity).findOne({ where: { id: transaction.customerId, tenantId } });
    if (!customer) {
      this.logger.warn(`CTR check: customer ${transaction.customerId} not found for tenant ${tenantId}`);
      return null;
    }

    const rule = await qr.manager.getRepository(RuleEntity).findOne({ where: { tenantId, scenarioType: RuleScenarioType.LARGE_CASH } });
    const config = (rule?.config ?? DEFAULT_RULE_CONFIGS.find((c) => c.scenarioType === RuleScenarioType.LARGE_CASH)?.config ?? {}) as LargeCashConfig;

    const result = evaluateLargeCash(
      {
        tenantId,
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
        now: new Date(),
      },
      config,
    );
    if (!result.fired) return null;

    const threshold = Number(result.evidence?.facts.thresholdApplied);
    return this.reportsService.generateCtr(qr, tenantId, transaction, customer, threshold);
  }

  /** Same shape as CasesModule's AlertStatusListener.withTenantContext — never app.bypass_rls. */
  private async withTenantContext<T>(tenantId: string, fn: (qr: QueryRunner) => Promise<T>): Promise<T> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await qr.query(`SELECT set_config('app.current_tenant_id', $1, true), set_config('app.bypass_rls', 'false', true)`, [tenantId]);
      const result = await fn(qr);
      await qr.commitTransaction();
      return result;
    } catch (err) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }
}
