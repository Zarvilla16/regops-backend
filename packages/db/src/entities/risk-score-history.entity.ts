import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";
import { RiskLevel, ScoreTrigger } from "@regops/shared";
import { CustomerEntity } from "./customer.entity";

/**
 * Append-only by convention (not by DB role) — every score calculation
 * inserts a new row, including when the score is unchanged. Never UPDATE or
 * DELETE these rows.
 */
@Entity({ name: "risk_score_history" })
export class RiskScoreHistoryEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "tenant_id", type: "uuid" })
  @Index()
  tenantId!: string;

  @Column({ name: "customer_id", type: "uuid" })
  @Index()
  customerId!: string;

  @ManyToOne(() => CustomerEntity, { onDelete: "CASCADE" })
  @JoinColumn({ name: "customer_id" })
  customer?: CustomerEntity;

  @Column({ type: "smallint" })
  score!: number;

  @Column({ type: "enum", enum: RiskLevel, enumName: "risk_level_enum" })
  level!: RiskLevel;

  /** Per-factor breakdown, e.g. { customer_type: 30, country: 0, ... } — the audit trail for how this score was reached. */
  @Column({ type: "jsonb" })
  factors!: Record<string, unknown>;

  @Column({ type: "enum", enum: ScoreTrigger, enumName: "score_trigger_enum" })
  trigger!: ScoreTrigger;

  @Column({ name: "previous_score", type: "smallint", nullable: true })
  previousScore!: number | null;

  @Column({
    name: "previous_level",
    type: "enum",
    enum: RiskLevel,
    enumName: "risk_level_enum",
    nullable: true,
  })
  previousLevel!: RiskLevel | null;

  @Column({ name: "calculated_at", type: "timestamptz" })
  calculatedAt!: Date;

  /** user_id for MANUAL trigger; NULL for SCHEDULED/system-initiated. */
  @Column({ name: "calculated_by", type: "uuid", nullable: true })
  calculatedBy!: string | null;
}
