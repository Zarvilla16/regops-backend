import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { CustomerStatus, CustomerType, RiskLevel } from "@regops/shared";

// Note: the enforced uniqueness constraints — (tenant_id, cbs_customer_id) and
// the partial (tenant_id, bvn) WHERE bvn IS NOT NULL — plus the pg_trgm
// fuzzy-search index on full_name are all created directly in the
// CustomerAndRisk migration, since TypeORM decorators cannot express partial
// or trigram-operator-class indexes.
@Entity({ name: "customer" })
export class CustomerEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "tenant_id", type: "uuid" })
  @Index()
  tenantId!: string;

  @Column({ name: "cbs_customer_id", type: "varchar", length: 100 })
  cbsCustomerId!: string;

  /** Plaintext at rest (Postgres at-rest encryption covers storage); always masked in API responses by default. */
  @Column({ type: "varchar", length: 11, nullable: true })
  bvn!: string | null;

  @Column({ type: "varchar", length: 11, nullable: true })
  nin!: string | null;

  @Column({ name: "full_name", type: "varchar", length: 255 })
  fullName!: string;

  @Column({ type: "varchar", length: 255, nullable: true })
  email!: string | null;

  @Column({ type: "varchar", length: 20, nullable: true })
  phone!: string | null;

  @Column({ name: "date_of_birth", type: "date", nullable: true })
  dateOfBirth!: Date | null;

  @Column({
    name: "customer_type",
    type: "enum",
    enum: CustomerType,
    enumName: "customer_type_enum",
  })
  @Index()
  customerType!: CustomerType;

  @Column({ type: "varchar", length: 100, nullable: true })
  occupation!: string | null;

  /** ISO 3166-1 alpha-2. */
  @Column({ type: "varchar", length: 2, default: "NG" })
  country!: string;

  /** ISO 3166-1 alpha-2. */
  @Column({ type: "varchar", length: 2, nullable: true })
  nationality!: string | null;

  @Column({ name: "kyc_tier", type: "smallint", default: 1 })
  kycTier!: number;

  @Column({ name: "risk_score", type: "smallint", default: 0 })
  riskScore!: number;

  @Column({
    name: "risk_level",
    type: "enum",
    enum: RiskLevel,
    enumName: "risk_level_enum",
    default: RiskLevel.LOW,
  })
  riskLevel!: RiskLevel;

  @Column({ name: "last_risk_calculated_at", type: "timestamptz", nullable: true })
  lastRiskCalculatedAt!: Date | null;

  @Column({ name: "is_pep", type: "boolean", default: false })
  isPep!: boolean;

  @Column({ name: "is_sanctioned", type: "boolean", default: false })
  isSanctioned!: boolean;

  /** Set by the screening module (Prompt 3). */
  @Column({ name: "last_screened_at", type: "timestamptz", nullable: true })
  lastScreenedAt!: Date | null;

  @Column({
    type: "enum",
    enum: CustomerStatus,
    enumName: "customer_status_enum",
    default: CustomerStatus.ACTIVE,
  })
  status!: CustomerStatus;

  @Column({ name: "onboarded_at", type: "timestamptz" })
  onboardedAt!: Date;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;

  @DeleteDateColumn({ name: "deleted_at", type: "timestamptz", nullable: true })
  deletedAt!: Date | null;
}
