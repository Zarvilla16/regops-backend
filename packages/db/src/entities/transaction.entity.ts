import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from "typeorm";
import { TransactionChannel, TransactionSource, TransactionType } from "@regops/shared";

/**
 * Partitioned by RANGE(occurred_at), monthly — see Transactions1700000040000.
 * Composite PK (id, occurred_at) is a Postgres requirement for any unique
 * constraint on a partitioned table, not a modeling choice; `id` is still
 * effectively globally unique (gen_random_uuid()) and application code never
 * needs occurred_at to look a row up, only to insert/delete one.
 *
 * customer_id / account_number / counterparty_customer_id are FK-by-convention
 * (no REFERENCES) — same choice already made for ScreeningCheckEntity: RLS
 * enforces tenant isolation, not referential integrity, and the ingestion
 * pipeline's own resolution step (ResolutionService) is what guarantees these
 * point at real rows before insert.
 */
@Entity({ name: "transaction" })
export class TransactionEntity {
  @PrimaryColumn({ type: "uuid" })
  id!: string;

  @Column({ name: "tenant_id", type: "uuid" })
  @Index()
  tenantId!: string;

  @Column({ name: "cbs_transaction_id", type: "varchar", length: 100 })
  cbsTransactionId!: string;

  @Column({ name: "customer_id", type: "uuid" })
  @Index()
  customerId!: string;

  @Column({ name: "account_number", type: "varchar", length: 50 })
  accountNumber!: string;

  /** No number transformer (unlike RiskFactorConfigEntity.weight) — money is
   * read/written as a decimal string end-to-end (matches TransactionDto.amount
   * and the transaction.ingested event payload) to avoid float precision loss. */
  @Column({ type: "numeric", precision: 18, scale: 2 })
  amount!: string;

  @Column({ type: "char", length: 3, default: "NGN" })
  currency!: string;

  @Column({ type: "enum", enum: TransactionType, enumName: "transaction_type_enum" })
  type!: TransactionType;

  @Column({ type: "enum", enum: TransactionChannel, enumName: "transaction_channel_enum" })
  channel!: TransactionChannel;

  @Column({ name: "counterparty_account", type: "varchar", length: 50, nullable: true })
  counterpartyAccount!: string | null;

  @Column({ name: "counterparty_bank", type: "varchar", length: 20, nullable: true })
  counterpartyBank!: string | null;

  @Column({ name: "counterparty_name", type: "varchar", length: 255, nullable: true })
  counterpartyName!: string | null;

  /** Populated by ResolutionService only when counterparty_account matches an
   * existing CustomerAccount within the same tenant (internal transfer). */
  @Column({ name: "counterparty_customer_id", type: "uuid", nullable: true })
  counterpartyCustomerId!: string | null;

  @Column({ type: "text", nullable: true })
  narration!: string | null;

  @Column({ type: "varchar", length: 100, nullable: true })
  reference!: string | null;

  @Column({ name: "balance_after", type: "numeric", precision: 18, scale: 2, nullable: true })
  balanceAfter!: string | null;

  /** Partition key — when the transaction happened in the CBS, not when we ingested it. */
  @PrimaryColumn({ name: "occurred_at", type: "timestamptz" })
  occurredAt!: Date;

  @CreateDateColumn({ name: "ingested_at", type: "timestamptz" })
  ingestedAt!: Date;

  @Column({ type: "enum", enum: TransactionSource, enumName: "transaction_source_enum" })
  source!: TransactionSource;

  @Column({ name: "ingestion_batch_id", type: "uuid", nullable: true })
  ingestionBatchId!: string | null;
}
