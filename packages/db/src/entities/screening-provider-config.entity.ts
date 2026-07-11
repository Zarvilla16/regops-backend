import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
import { ScreeningCheckType, ScreeningProviderName } from "@regops/shared";

/**
 * Per-tenant configuration of which providers are active and how they're
 * prioritized (Section 3.1). The uniqueness rule "only one primary per
 * (tenant, check_type)" is a partial unique index (WHERE is_primary = true),
 * not expressible via TypeORM decorators — created directly in the
 * Screening1700000020000 migration.
 */
@Entity({ name: "screening_provider_config" })
export class ScreeningProviderConfigEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "tenant_id", type: "uuid" })
  @Index()
  tenantId!: string;

  @Column({ type: "enum", enum: ScreeningProviderName, enumName: "screening_provider_name_enum" })
  provider!: ScreeningProviderName;

  @Column({ name: "check_type", type: "enum", enum: ScreeningCheckType, enumName: "screening_check_type_enum" })
  checkType!: ScreeningCheckType;

  @Column({ name: "is_primary", type: "boolean", default: false })
  isPrimary!: boolean;

  @Column({ name: "is_fallback", type: "boolean", default: false })
  isFallback!: boolean;

  /** Never plaintext — a reference the provider implementation resolves at
   * call time via SecretsService (Section 7.4), e.g. "env://SMILE_ID_API_KEY_TENANT_<id>". */
  @Column({ name: "credentials_ref", type: "text" })
  credentialsRef!: string;

  /** Provider-specific knobs (baseUrl override, timeoutMs override, etc). */
  @Column({ type: "jsonb", default: {} })
  config!: Record<string, unknown>;

  @Column({ name: "is_active", type: "boolean", default: true })
  isActive!: boolean;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
