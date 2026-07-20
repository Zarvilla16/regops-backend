import { Injectable, NotFoundException } from "@nestjs/common";
import { QueryRunner } from "typeorm";
import { RiskFactorConfigEntity, TransactionEntity } from "@regops/db";
import { RiskFactorType, TransactionChannel, TransactionDto, VelocityStatsDto } from "@regops/shared";
import { VelocityAdapterService } from "./velocity-adapter.service";

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
  ): Promise<{ data: TransactionDto[]; total: number }> {
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
    if (filters.type) qb.andWhere("t.type = :type", { type: filters.type });
    if (filters.channels?.length) qb.andWhere("t.channel IN (:...channels)", { channels: filters.channels });
    if (filters.amountMin !== undefined) qb.andWhere("t.amount >= :amountMin", { amountMin: filters.amountMin });
    if (filters.amountMax !== undefined) qb.andWhere("t.amount <= :amountMax", { amountMax: filters.amountMax });
    if (filters.occurredFrom) qb.andWhere("t.occurred_at >= :occurredFrom", { occurredFrom: filters.occurredFrom });
    if (filters.occurredTo) qb.andWhere("t.occurred_at <= :occurredTo", { occurredTo: filters.occurredTo });
    if (filters.source) qb.andWhere("t.source = :source", { source: filters.source });
    if (filters.ingestionBatchId) {
      qb.andWhere("t.ingestion_batch_id = :ingestionBatchId", { ingestionBatchId: filters.ingestionBatchId });
    }

    qb.orderBy("t.occurred_at", "DESC")
      .skip((page - 1) * limit)
      .take(limit);

    const [rows, total] = await qb.getManyAndCount();
    return { data: rows.map((r) => this.toDto(r)), total };
  }

  async findById(queryRunner: QueryRunner, tenantId: string, id: string): Promise<TransactionDto> {
    const txn = await queryRunner.manager.getRepository(TransactionEntity).findOne({ where: { tenantId, id } });
    if (!txn) {
      throw new NotFoundException({ code: "TRANSACTION_NOT_FOUND", message: "Transaction not found." });
    }
    return this.toDto(txn);
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
