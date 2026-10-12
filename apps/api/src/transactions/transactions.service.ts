import { Injectable, NotFoundException } from "@nestjs/common";
import { QueryRunner } from "typeorm";
import { CustomerEntity, RiskFactorConfigEntity, TransactionEntity } from "@regops/db";
import { RiskFactorType, TransactionChannel, TransactionDto, VelocityStatsDto } from "@regops/shared";
import { VelocityAdapterService } from "./velocity-adapter.service";

/** List/detail row the console renders: the transaction plus its customer and, if flagged, its latest alert. */
export type TransactionRowDto = TransactionDto & {
  customer: { id: string; fullName: string } | null;
  alert: { id: string; title: string; scenario: string } | null;
};

export interface TransactionStatsDto {
  totalCount: number;
  ingestedToday: number;
  valueToday: number;
  flaggedCount: number;
  flaggedPct: number;
  lastBatch: { id: string; occurredAt: string; count: number } | null;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** "Today" for ingestion stats is the Lagos calendar day, not the server's (UTC). */
const BUSINESS_TIME_ZONE = "Africa/Lagos";

export interface TransactionFilters {
  customerId?: string;
  accountNumber?: string;
  counterpartyAccount?: string;
  counterpartyCustomerId?: string;
  type?: string;
  channels?: TransactionChannel[];
  amountMin?: number;
  amountMax?: number;
  occurredFrom?: string;
  occurredTo?: string;
  source?: string;
  ingestionBatchId?: string;
}

@Injectable()
export class TransactionsService {
  constructor(private readonly velocityAdapterService: VelocityAdapterService) {}

  toDto(txn: TransactionEntity): TransactionDto {
    return {
      id: txn.id,
      tenantId: txn.tenantId,
      cbsTransactionId: txn.cbsTransactionId,
      customerId: txn.customerId,
      accountNumber: txn.accountNumber,
      amount: txn.amount,
      currency: txn.currency,
      type: txn.type,
      channel: txn.channel,
      counterpartyAccount: txn.counterpartyAccount,
      counterpartyBank: txn.counterpartyBank,
      counterpartyName: txn.counterpartyName,
      counterpartyCustomerId: txn.counterpartyCustomerId,
      narration: txn.narration,
      reference: txn.reference,
      balanceAfter: txn.balanceAfter,
      occurredAt: txn.occurredAt.toISOString(),
      ingestedAt: txn.ingestedAt.toISOString(),
      source: txn.source,
      ingestionBatchId: txn.ingestionBatchId,
    };
  }

  /** Shared by GET /transactions and GET /customers/:id/transactions (the
   * latter just pins filters.customerId before calling this). */
  async findAll(
    queryRunner: QueryRunner,
    tenantId: string,
    filters: TransactionFilters,
    page: number,
    limit: number,
  ): Promise<{ data: TransactionRowDto[]; total: number }> {
    const qb = queryRunner.manager
      .createQueryBuilder(TransactionEntity, "t")
      .where("t.tenant_id = :tenantId", { tenantId });

    if (filters.customerId) qb.andWhere("t.customer_id = :customerId", { customerId: filters.customerId });
    if (filters.accountNumber) qb.andWhere("t.account_number = :accountNumber", { accountNumber: filters.accountNumber });
    if (filters.counterpartyAccount) {
      qb.andWhere("t.counterparty_account = :counterpartyAccount", { counterpartyAccount: filters.counterpartyAccount });
    }
    if (filters.counterpartyCustomerId) {
      qb.andWhere("t.counterparty_customer_id = :counterpartyCustomerId", {
        counterpartyCustomerId: filters.counterpartyCustomerId,
      });
    }
    // `type` may be a comma-separated list (the console sends e.g. "CREDIT,DEBIT").
    const types = filters.type?.split(",").map((v) => v.trim()).filter(Boolean);
    if (types?.length) qb.andWhere("t.type IN (:...types)", { types });
    if (filters.channels?.length) qb.andWhere("t.channel IN (:...channels)", { channels: filters.channels });
    if (filters.amountMin !== undefined) qb.andWhere("t.amount >= :amountMin", { amountMin: filters.amountMin });
    if (filters.amountMax !== undefined) qb.andWhere("t.amount <= :amountMax", { amountMax: filters.amountMax });
    if (filters.occurredFrom) qb.andWhere("t.occurred_at >= :occurredFrom", { occurredFrom: filters.occurredFrom });
    if (filters.occurredTo) {
      // A bare YYYY-MM-DD end date means "through the end of that day", not "up to its midnight".
      if (DATE_ONLY.test(filters.occurredTo)) {
        qb.andWhere("t.occurred_at < (:occurredTo::date + interval '1 day')", { occurredTo: filters.occurredTo });
      } else {
        qb.andWhere("t.occurred_at <= :occurredTo", { occurredTo: filters.occurredTo });
      }
    }
    if (filters.source) qb.andWhere("t.source = :source", { source: filters.source });
    if (filters.ingestionBatchId) {
      qb.andWhere("t.ingestion_batch_id = :ingestionBatchId", { ingestionBatchId: filters.ingestionBatchId });
    }

    qb.orderBy("t.occurred_at", "DESC")
      .skip((page - 1) * limit)
      .take(limit);

    const [rows, total] = await qb.getManyAndCount();
    return { data: await this.toRowDtos(queryRunner, tenantId, rows), total };
  }

  async findById(queryRunner: QueryRunner, tenantId: string, id: string): Promise<TransactionRowDto> {
    const txn = await queryRunner.manager.getRepository(TransactionEntity).findOne({ where: { tenantId, id } });
    if (!txn) {
      throw new NotFoundException({ code: "TRANSACTION_NOT_FOUND", message: "Transaction not found." });
    }
    return (await this.toRowDtos(queryRunner, tenantId, [txn]))[0];
  }

  /** Adds the customer name and the most recent alert that references each transaction (two queries total). */
  private async toRowDtos(queryRunner: QueryRunner, tenantId: string, txns: TransactionEntity[]): Promise<TransactionRowDto[]> {
    if (txns.length === 0) return [];

    const customerIds = [...new Set(txns.map((t) => t.customerId))];
    const customers = await queryRunner.manager
      .getRepository(CustomerEntity)
      .createQueryBuilder("c")
      .withDeleted()
      .select(["c.id", "c.fullName"])
      .where("c.tenant_id = :tenantId", { tenantId })
      .andWhere("c.id IN (:...customerIds)", { customerIds })
      .getMany();
    const customerById = new Map(customers.map((c) => [c.id, c]));

    const txnIds = txns.map((t) => t.id);
    const alertRows: { txid: string; id: string; title: string; scenario_type: string }[] = await queryRunner.manager.query(
      `SELECT DISTINCT ON (x.txid) x.txid, x.id, x.title, x.scenario_type
         FROM (
           SELECT a.triggering_transaction_id::text AS txid, a.id, a.title, a.scenario_type, a.created_at
             FROM alert a
            WHERE a.tenant_id = $1 AND a.triggering_transaction_id = ANY($2::uuid[])
           UNION ALL
           SELECT rel AS txid, a.id, a.title, a.scenario_type, a.created_at
             FROM alert a,
                  LATERAL jsonb_array_elements_text(
                    CASE WHEN jsonb_typeof(a.evidence->'relatedTransactionIds') = 'array'
                         THEN a.evidence->'relatedTransactionIds' ELSE '[]'::jsonb END
                  ) AS rel
            WHERE a.tenant_id = $1 AND rel = ANY($3::text[])
         ) x
        ORDER BY x.txid, x.created_at DESC`,
      [tenantId, txnIds, txnIds],
    );
    const alertByTxn = new Map(alertRows.map((a) => [a.txid, a]));

    return txns.map((t) => {
      const customer = customerById.get(t.customerId);
      const alert = alertByTxn.get(t.id);
      return {
        ...this.toDto(t),
        customer: customer ? { id: customer.id, fullName: customer.fullName } : null,
        alert: alert ? { id: alert.id, title: alert.title, scenario: alert.scenario_type } : null,
      };
    });
  }

  /**
   * KPI figures for the transactions page, computed in SQL over the tenant's full set (not one page).
   * "Today" is the Lagos calendar day. "Flagged" counts distinct transactions referenced by any alert,
   * as its trigger or in its related-transaction evidence.
   */
  async getStats(queryRunner: QueryRunner, tenantId: string): Promise<TransactionStatsDto> {
    const [totals] = await queryRunner.manager.query(
      `SELECT count(*)::int AS total_count,
              count(*) FILTER (WHERE ingested_at >= day_start.ts)::int AS ingested_today,
              COALESCE(sum(amount) FILTER (WHERE ingested_at >= day_start.ts), 0)::float8 AS value_today
         FROM "transaction",
              (SELECT date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2 AS ts) AS day_start
        WHERE tenant_id = $1`,
      [tenantId, BUSINESS_TIME_ZONE],
    );

    const [flagged] = await queryRunner.manager.query(
      `WITH referenced AS (
         SELECT triggering_transaction_id AS id FROM alert
          WHERE tenant_id = $1 AND triggering_transaction_id IS NOT NULL
         UNION
         SELECT rel::uuid FROM alert a,
                LATERAL jsonb_array_elements_text(
                  CASE WHEN jsonb_typeof(a.evidence->'relatedTransactionIds') = 'array'
                       THEN a.evidence->'relatedTransactionIds' ELSE '[]'::jsonb END
                ) AS rel
          WHERE a.tenant_id = $1
       )
       SELECT count(*)::int AS flagged_count
         FROM referenced r
         JOIN "transaction" t ON t.id = r.id AND t.tenant_id = $1`,
      [tenantId],
    );

    const [batch] = await queryRunner.manager.query(
      `SELECT id, COALESCE(completed_at, created_at) AS occurred_at, succeeded_rows
         FROM ingestion_batch
        WHERE tenant_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [tenantId],
    );

    const totalCount = Number(totals.total_count);
    const flaggedCount = Number(flagged.flagged_count);
    return {
      totalCount,
      ingestedToday: Number(totals.ingested_today),
      valueToday: Number(totals.value_today),
      flaggedCount,
      flaggedPct: totalCount ? Math.round((flaggedCount / totalCount) * 100) : 0,
      lastBatch: batch
        ? { id: batch.id, occurredAt: new Date(batch.occurred_at).toISOString(), count: Number(batch.succeeded_rows) }
        : null,
    };
  }

  /** GET /customers/:id/velocity-stats (Section 10) — debug view of the same
   * calculation RiskService's TransactionVelocityFactor closure adapter runs
   * during a real risk score calculation, using the tenant's actual tuned
   * config rather than defaults. */
  async getVelocityStats(queryRunner: QueryRunner, tenantId: string, customerId: string): Promise<VelocityStatsDto> {
    const config = await queryRunner.manager
      .getRepository(RiskFactorConfigEntity)
      .findOne({ where: { tenantId, factorType: RiskFactorType.TRANSACTION_VELOCITY } });

    const { score, detail } = await this.velocityAdapterService.getStats(
      queryRunner,
      tenantId,
      customerId,
      config?.config ?? {},
      new Date(),
    );
    return { customerId, score, detail };
  }
}
