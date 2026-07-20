import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { AlertSeverity, RuleAction, RuleScenarioType } from "@regops/shared";

/**
 * One row per (tenant, scenario_type) in v1 — enforced by a plain UNIQUE
 * index in RulesAndAlerts1700000050000 (Section 3.1: "a tenant has exactly
 * one Rule per scenario_type"). `config` shape is scenario-specific; see
 * packages/rules-engine's per-evaluator Config interfaces and
 * DEFAULT_RULE_CONFIGS for what each scenario_type expects.
 */
@Entity({ name: "rule" })
export class RuleEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "tenant_id", type: "uuid" })
  @Index()
  tenantId!: string;

  @Column({ type: "varchar", length: 255 })
  name!: string;

  @Column({
    name: "scenario_type",
    type: "enum",
    enum: RuleScenarioType,
    enumName: "rule_scenario_type_enum",
  })
  scenarioType!: RuleScenarioType;

  @Column({ type: "text", nullable: true })
  description!: string | null;

  @Column({ type: "jsonb" })
  config!: Record<string, unknown>;

  @Column({ type: "enum", enum: AlertSeverity, enumName: "alert_severity_enum" })
  severity!: AlertSeverity;

  @Column({ type: "enum", enum: RuleAction, enumName: "rule_action_enum", default: RuleAction.FLAG })
  action!: RuleAction;

  @Column({ name: "is_active", type: "boolean", default: true })
  isActive!: boolean;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;

  @DeleteDateColumn({ name: "deleted_at", type: "timestamptz", nullable: true })
  deletedAt!: Date | null;
}
