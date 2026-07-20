import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";
import { IngestionBatchStatus, TransactionSource } from "@regops/shared";

/**
 * Tracks the lifecycle of one ingestion batch (an SFTP-emulated file drop or
 * a webhook request) — persisted (not inferred from BullMQ job state alone,
 * unlike CustomerIngestionService) because both ingestion paths write to it
 * and GET /transactions/batches must list independent of any single job.
 */
@Entity({ name: "ingestion_batch" })
export class IngestionBatchEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "tenant_id", type: "uuid" })
  @Index()
  tenantId!: string;

  @Column({ type: "enum", enum: TransactionSource, enumName: "transaction_source_enum" })
  source!: TransactionSource;

  /** SFTP-emulated filename or the webhook request's Idempotency-Key. */
  @Column({ name: "source_reference", type: "varchar", length: 500, nullable: true })
  sourceReference!: string | null;

  @Column({ type: "enum", enum: IngestionBatchStatus, enumName: "ingestion_batch_status_enum" })
  status!: IngestionBatchStatus;

  @Column({ name: "total_rows", type: "integer", default: 0 })
  totalRows!: number;

  @Column({ name: "processed_rows", type: "integer", default: 0 })
  processedRows!: number;

  @Column({ name: "succeeded_rows", type: "integer", default: 0 })
  succeededRows!: number;

  @Column({ name: "failed_rows", type: "integer", default: 0 })
  failedRows!: number;

  /** FileStorage key for the error-report CSV, same "not a literal browsable
   * URL" caveat as CustomerEntity.photoUrl — proxy through GET /transactions/batches/:id/errors. */
  @Column({ name: "error_report_url", type: "text", nullable: true })
  errorReportUrl!: string | null;

  @Column({ name: "started_at", type: "timestamptz", nullable: true })
  startedAt!: Date | null;

  @Column({ name: "completed_at", type: "timestamptz", nullable: true })
  completedAt!: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
