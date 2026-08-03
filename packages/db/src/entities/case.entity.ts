import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
import { CasePriority, CaseStatus } from "@regops/shared";

/**
 * case_number's per-tenant-per-year uniqueness and customer_id/assigned_to/
 * created_by/submitted_by/approved_by/closed_by FK-by-convention are the same
 * choices as every table since Prompt 2 — RLS enforces tenant isolation, not
 * referential integrity. The unique index on (tenant_id, case_number) is
 * created directly in the migration (composite, not expressible cleanly via
 * a single-column @Index() decorator).
 */
@Entity({ name: "case" })
export class CaseEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "tenant_id", type: "uuid" })
  @Index()
  tenantId!: string;

  @Column({ name: "case_number", type: "varchar", length: 50 })
  caseNumber!: string;

  @Column({ name: "customer_id", type: "uuid" })
  @Index()
  customerId!: string;

  @Column({ type: "enum", enum: CaseStatus, enumName: "case_status_enum", default: CaseStatus.OPEN })
  status!: CaseStatus;

  @Column({ type: "enum", enum: CasePriority, enumName: "case_priority_enum" })
  priority!: CasePriority;

  @Column({ name: "assigned_to", type: "uuid", nullable: true })
  assignedTo!: string | null;

  @Column({ name: "created_by", type: "uuid" })
  createdBy!: string;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;

  @Column({ name: "submitted_by", type: "uuid", nullable: true })
  submittedBy!: string | null;

  @Column({ name: "submitted_at", type: "timestamptz", nullable: true })
  submittedAt!: Date | null;

  @Column({ name: "approved_by", type: "uuid", nullable: true })
  approvedBy!: string | null;

  @Column({ name: "approved_at", type: "timestamptz", nullable: true })
  approvedAt!: Date | null;

  @Column({ name: "escalation_rationale", type: "text", nullable: true })
  escalationRationale!: string | null;

  @Column({ name: "closed_at", type: "timestamptz", nullable: true })
  closedAt!: Date | null;

  @Column({ name: "closed_by", type: "uuid", nullable: true })
  closedBy!: string | null;

  @Column({ name: "closure_reason", type: "text", nullable: true })
  closureReason!: string | null;
}
