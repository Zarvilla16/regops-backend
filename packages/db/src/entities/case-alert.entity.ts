import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/**
 * Replaces the mock's `alertIds: string[]` array with a real join table.
 * The "one case per alert" rule (Section 2.3) is enforced by a PARTIAL
 * UNIQUE INDEX on alert_id ALONE (not (case_id, alert_id)) created directly
 * in the migration — TypeORM decorators can't express this, same reason
 * AlertEntity's dedup_key uniqueness lives in its own migration.
 */
@Entity({ name: "case_alert" })
export class CaseAlertEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "tenant_id", type: "uuid" })
  @Index()
  tenantId!: string;

  @Column({ name: "case_id", type: "uuid" })
  @Index()
  caseId!: string;

  @Column({ name: "alert_id", type: "uuid" })
  alertId!: string;

  @Column({ name: "linked_at", type: "timestamptz" })
  linkedAt!: Date;

  @Column({ name: "linked_by", type: "uuid" })
  linkedBy!: string;
}
