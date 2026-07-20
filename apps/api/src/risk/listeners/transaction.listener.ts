import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { DataSource, QueryRunner } from "typeorm";
import { CustomerEntity } from "@regops/db";
import { TransactionIngestionQueueService } from "../../transactions/ingestion/ingestion-queue.service";
import { RiskService } from "../risk.service";

const DEBOUNCE_TTL_MS = 60 * 1000;

interface TransactionIngestedEventPayload {
  tenantId: string;
  customerId: string;
}

/**
 * Spec Section 9.4: every transaction.ingested event is a potential re-score
 * trigger, debounced 60s per (tenantId, customerId) so a customer with 100
 * transactions in a minute enqueues one re-score, not 100. Lives in
 * RiskModule (not TransactionsModule) so the dependency stays one-directional
 * — RiskModule already imports TransactionsModule for VelocityAdapterService
 * and TransactionIngestionQueueService; TransactionsModule imports nothing
 * back, since events are the only coupling (EventEmitter2 is global).
 */
@Injectable()
export class TransactionListener {
  private readonly logger = new Logger(TransactionListener.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly riskService: RiskService,
    private readonly ingestionQueueService: TransactionIngestionQueueService,
  ) {}

  @OnEvent("transaction.ingested")
  async onTransactionIngested(event: TransactionIngestedEventPayload): Promise<void> {
    try {
      const lockKey = `rescore-debounce:${event.tenantId}:${event.customerId}`;
      const acquired = await this.ingestionQueueService.acquireLock(lockKey, DEBOUNCE_TTL_MS);
      if (!acquired) return; // another transaction for this customer already triggered a re-score within the last 60s

      await this.withTenantContext(event.tenantId, async (qr) => {
        const customer = await qr.manager
          .getRepository(CustomerEntity)
          .findOne({ where: { tenantId: event.tenantId, id: event.customerId } });
        if (!customer) return; // stale/cross-tenant payload — nothing to re-score
        await this.riskService.rescoreEventTriggered(qr, customer);
      });
    } catch (err) {
      this.logger.error(`Failed to process transaction.ingested re-score for customer ${event.customerId}`, err as Error);
    }
  }

  /** Same shape as RescoreSchedulerService.withTenantContext — never
   * app.bypass_rls, confined to exactly the tenant this event names. */
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
