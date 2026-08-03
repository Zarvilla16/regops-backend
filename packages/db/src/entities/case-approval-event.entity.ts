import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";
import { CaseApprovalOutcome } from "@regops/shared";

@Entity({ name: "case_approval_event" })
export class CaseApprovalEventEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "tenant_id", type: "uuid" })
  @Index()
  tenantId!: string;

  @Column({ name: "case_id", type: "uuid" })
  @Index()
  caseId!: string;

  @Column({ type: "enum", enum: CaseApprovalOutcome, enumName: "case_approval_outcome_enum" })
  outcome!: CaseApprovalOutcome;

  @Column({ type: "uuid" })
  actor!: string;

  @Column({ type: "text", nullable: true })
  reason!: string | null;

  @Column({ type: "timestamptz" })
  at!: Date;
}
