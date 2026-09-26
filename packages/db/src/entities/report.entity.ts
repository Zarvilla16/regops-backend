import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
import { ReportStatus, ReportType } from "@regops/shared";

/**
 * One entity for both SAR and CTR (Backend Prompt 7, Section 2.1). Exactly one
 * of case_id / transaction_id is set, fully determined by report_type:
 * SAR -> case_id, CTR -> transaction_id. Enforced at the DB level by
 * `ck_report_subject` (created in 1700000062000-Reports.ts) as well as by
 * application-level validation on every write path.
 *
 * The partial unique indexes on case_id / transaction_id (WHERE ... IS NOT
 * NULL) also live only in the migration — TypeORM decorators cannot express
 * partial indexes. transaction_id's one is the CTR idempotency backstop.
 */
@Entity({ name: "report" })
export class ReportEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "tenant_id", type: "uuid" })
  @Index()
  tenantId!: string;

  @Column({ name: "case_id", type: "uuid", nullable: true })
  caseId!: string | null;

  @Column({ name: "transaction_id", type: "uuid", nullable: true })
  transactionId!: string | null;

  @Column({ name: "customer_id", type: "uuid" })
  customerId!: string;

  @Column({ name: "report_type", type: "enum", enum: ReportType, enumName: "report_type_enum" })
  reportType!: ReportType;

  @Column({ type: "enum", enum: ReportStatus, enumName: "report_status_enum", default: ReportStatus.DRAFT })
  status!: ReportStatus;

  /** numeric(20,2) — returned by the pg driver as a decimal string. */
  @Column({ name: "flagged_amount", type: "numeric", precision: 20, scale: 2, nullable: true })
  flaggedAmount!: string | null;

  @Column({ type: "text", nullable: true })
  narrative!: string | null;

  @Column({ name: "generated_at", type: "timestamptz" })
  generatedAt!: Date;

  /** null = system-generated (every CTR). */
  @Column({ name: "generated_by", type: "uuid", nullable: true })
  generatedBy!: string | null;

  @Column({ name: "submitted_by", type: "uuid", nullable: true })
  submittedBy!: string | null;

  @Column({ name: "submitted_at", type: "timestamptz", nullable: true })
  submittedAt!: Date | null;

  @Column({ name: "confirmed_by", type: "uuid", nullable: true })
  confirmedBy!: string | null;

  @Column({ name: "confirmed_at", type: "timestamptz", nullable: true })
  confirmedAt!: Date | null;

  @Column({ name: "nfiu_reference", type: "text", nullable: true })
  nfiuReference!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
