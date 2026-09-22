import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/**
 * Durable, insert-only record of every CasesService.submit() call — never
 * updated or deleted by reject(), unlike the live case.submitted_by/
 * submitted_at columns, which reject() nulls so a resubmission starts clean.
 * CaseTimelineService reads this table (not the live columns) to render
 * "submitted" events, so a case submitted, rejected, and resubmitted shows
 * its full submission history, not just the most recent attempt.
 */
@Entity({ name: "case_submission_event" })
export class CaseSubmissionEventEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "tenant_id", type: "uuid" })
  @Index()
  tenantId!: string;

  @Column({ name: "case_id", type: "uuid" })
  @Index()
  caseId!: string;

  @Column({ type: "uuid" })
  actor!: string;

  @Column({ type: "text" })
  rationale!: string;

  @Column({ type: "timestamptz" })
  at!: Date;
}
