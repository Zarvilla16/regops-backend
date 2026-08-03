import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
import { ReportStatus, ReportType } from "@regops/shared";

/**
 * Deliberately thin seed entity (Section 2.4/6) — auto-created the moment a
 * Case is approved into SAR_FILED. Backend Prompt 7 owns the real Reports
 * module and is expected to extend this substantially (narrative, flagged
 * amount, submission fields, XML content); do not add those fields here.
 * case_id is unique — one report per case.
 */
@Entity({ name: "report" })
export class ReportEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "tenant_id", type: "uuid" })
  @Index()
  tenantId!: string;

  @Column({ name: "case_id", type: "uuid" })
  caseId!: string;

  @Column({ name: "customer_id", type: "uuid" })
  customerId!: string;

  @Column({ name: "report_type", type: "enum", enum: ReportType, enumName: "report_type_enum" })
  reportType!: ReportType;

  @Column({ type: "enum", enum: ReportStatus, enumName: "report_status_enum", default: ReportStatus.DRAFT })
  status!: ReportStatus;

  @Column({ name: "generated_at", type: "timestamptz" })
  generatedAt!: Date;

  @Column({ name: "generated_by", type: "uuid" })
  generatedBy!: string;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
