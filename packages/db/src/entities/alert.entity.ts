import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
import { AlertCloseCategory, AlertSeverity, AlertStatus, RuleScenarioType } from "@regops/shared";

/**
 * dedup_key uniqueness is a PARTIAL unique index (`WHERE status != 'CLOSED'`)
 * created directly in RulesAndAlerts1700000050000 — TypeORM decorators can't
 * express a partial index, same reason CustomerEntity's partial BVN
 * uniqueness lives in its migration, not here. A closed alert's dedup_key
 * can recur later (Section 3.2): the same pattern firing again after closure
 * is itself a signal, not noise to suppress.
 *
 * triggering_transaction_id is FK-by-convention only (no REFERENCES) — same
 * choice as every other cross-reference into the partitioned `transaction`
 * table (see TransactionEntity's docblock).
 */
@Entity({ name: "alert" })
export class AlertEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "tenant_id", type: "uuid" })
  @Index()
  tenantId!: string;

  @Column({ name: "rule_id", type: "uuid" })
  ruleId!: string;

  @Column({ name: "customer_id", type: "uuid" })
  @Index()
  customerId!: string;

  @Column({ name: "triggering_transaction_id", type: "uuid", nullable: true })
  triggeringTransactionId!: string | null;

  /** Denormalized from Rule.scenarioType for filtering speed (Section 3.2). */
  @Column({ name: "scenario_type", type: "enum", enum: RuleScenarioType, enumName: "rule_scenario_type_enum" })
  scenarioType!: RuleScenarioType;

  @Column({ type: "enum", enum: AlertSeverity, enumName: "alert_severity_enum" })
  severity!: AlertSeverity;

  @Column({ type: "enum", enum: AlertStatus, enumName: "alert_status_enum", default: AlertStatus.NEW })
  status!: AlertStatus;

  @Column({ type: "varchar", length: 500 })
  title!: string;

  @Column({ type: "jsonb" })
  evidence!: Record<string, unknown>;

  @Column({ name: "dedup_key", type: "varchar", length: 255 })
  dedupKey!: string;

  @Column({ name: "fire_count", type: "integer", default: 1 })
  fireCount!: number;

  @Column({ name: "first_fired_at", type: "timestamptz" })
  firstFiredAt!: Date;

  @Column({ name: "last_fired_at", type: "timestamptz" })
  lastFiredAt!: Date;

  @Column({ name: "assigned_to", type: "uuid", nullable: true })
  assignedTo!: string | null;

  @Column({ name: "closed_at", type: "timestamptz", nullable: true })
  closedAt!: Date | null;

  @Column({ name: "closed_by", type: "uuid", nullable: true })
  closedBy!: string | null;

  @Column({ name: "close_category", type: "enum", enum: AlertCloseCategory, enumName: "alert_close_category_enum", nullable: true })
  closeCategory!: AlertCloseCategory | null;

  @Column({ name: "closure_reason", type: "text", nullable: true })
  closureReason!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
