import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/** Index 0 (inserted at case creation) is the implicit "opened" assignment,
 * skipped by CaseTimelineService — see Section 3.8. */
@Entity({ name: "case_assignment_event" })
export class CaseAssignmentEventEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "tenant_id", type: "uuid" })
  @Index()
  tenantId!: string;

  @Column({ name: "case_id", type: "uuid" })
  @Index()
  caseId!: string;

  @Column({ name: "assigned_to", type: "uuid", nullable: true })
  assignedTo!: string | null;

  @Column({ name: "assigned_by", type: "uuid" })
  assignedBy!: string;

  @Column({ type: "timestamptz" })
  at!: Date;
}
