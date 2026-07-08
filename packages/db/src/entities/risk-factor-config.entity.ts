import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
import { RiskFactorType } from "@regops/shared";

// Note: the enforced UNIQUE (tenant_id, factor_type) constraint is created
// directly in the CustomerAndRisk migration alongside the table.
@Entity({ name: "risk_factor_config" })
export class RiskFactorConfigEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "tenant_id", type: "uuid" })
  @Index()
  tenantId!: string;

  @Column({ name: "factor_type", type: "enum", enum: RiskFactorType, enumName: "risk_factor_type_enum" })
  factorType!: RiskFactorType;

  /** Multiplier applied to the factor's raw 0-100 score; 1.00 = baseline. Stored as numeric(4,2), read back as a JS number via the transformer below. */
  @Column({
    type: "decimal",
    precision: 4,
    scale: 2,
    default: 1.0,
    transformer: {
      to: (value: number) => value,
      from: (value: string) => parseFloat(value),
    },
  })
  weight!: number;

  /** Factor-specific configuration — shape depends on factorType, see risk/config/default-configs.ts. */
  @Column({ type: "jsonb" })
  config!: Record<string, unknown>;

  @Column({ name: "is_active", type: "boolean", default: true })
  isActive!: boolean;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
