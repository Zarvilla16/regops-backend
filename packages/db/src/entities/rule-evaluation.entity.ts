import { Column, Entity, Index, PrimaryColumn } from "typeorm";
import { RuleEvaluationResultStatus } from "@regops/shared";

/**
 * Partitioned by RANGE(evaluated_at), monthly — same pattern as
 * TransactionEntity (composite PK required by Postgres for a unique
 * constraint on a partitioned table). High-volume by design (one row per
 * active rule per evaluated transaction — 5 rows per transaction at v1's
 * fixed 5-scenario catalog); Section 3.3's 90-day retention is enforced
 * operationally (partition drop), not by this entity.
 */
@Entity({ name: "rule_evaluation" })
export class RuleEvaluationEntity {
  @PrimaryColumn({ type: "uuid" })
  id!: string;

  @Column({ name: "tenant_id", type: "uuid" })
  @Index()
  tenantId!: string;

  @Column({ name: "rule_id", type: "uuid" })
  ruleId!: string;

  /** Nullable for replay runs against a rule that has since had its rule_id
   * itself deleted, and also nullable per spec Section 3.3 for consistency
   * with how replay-originated rows are described. */
  @Column({ name: "transaction_id", type: "uuid", nullable: true })
  transactionId!: string | null;

  /** Partition key. */
  @PrimaryColumn({ name: "evaluated_at", type: "timestamptz" })
  evaluatedAt!: Date;

  @Column({ name: "duration_ms", type: "integer" })
  durationMs!: number;

  @Column({ type: "enum", enum: RuleEvaluationResultStatus, enumName: "rule_evaluation_result_enum" })
  result!: RuleEvaluationResultStatus;

  @Column({ name: "alert_id", type: "uuid", nullable: true })
  alertId!: string | null;

  @Column({ name: "error_message", type: "text", nullable: true })
  errorMessage!: string | null;
}
