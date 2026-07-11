import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";
import { ScreeningCheckStatus, ScreeningCheckType, ScreeningProviderName, ScreeningResultType, ScreeningTrigger } from "@regops/shared";

/**
 * Every screening attempt is recorded — successful or failed, match or
 * no-match (Section 3.2). `customerId` is nullable: the synchronous
 * sanctions pre-screen (Section 5.1) runs BEFORE the Customer row exists, so
 * a check that blocks customer creation stays in this table with
 * customer_id NULL as audit evidence of the block.
 */
@Entity({ name: "screening_check" })
export class ScreeningCheckEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "tenant_id", type: "uuid" })
  @Index()
  tenantId!: string;

  @Column({ name: "customer_id", type: "uuid", nullable: true })
  @Index()
  customerId!: string | null;

  @Column({ name: "check_type", type: "enum", enum: ScreeningCheckType, enumName: "screening_check_type_enum" })
  checkType!: ScreeningCheckType;

  @Column({ type: "enum", enum: ScreeningProviderName, enumName: "screening_provider_name_enum" })
  provider!: ScreeningProviderName;

  /** What was sent (name, dob, country, etc.) — never bvn/nin in the clear beyond what's already masked elsewhere. */
  @Column({ name: "input_data", type: "jsonb" })
  inputData!: Record<string, unknown>;

  /** sha256 of normalized input_data — Section 5.5's dedup key. */
  @Column({ name: "input_hash", type: "char", length: 64 })
  inputHash!: string;

  @Column({ type: "enum", enum: ScreeningCheckStatus, enumName: "screening_check_status_enum" })
  status!: ScreeningCheckStatus;

  @Column({ type: "enum", enum: ScreeningResultType, enumName: "screening_result_type_enum", nullable: true })
  result!: ScreeningResultType | null;

  @Column({ name: "highest_match_score", type: "smallint", nullable: true })
  highestMatchScore!: number | null;

  @Column({ name: "provider_reference", type: "varchar", length: 255, nullable: true })
  providerReference!: string | null;

  /** Full provider response, debug aid — never rendered directly to non-compliance roles. */
  @Column({ name: "raw_response", type: "jsonb", nullable: true })
  rawResponse!: unknown;

  @Column({ name: "error_message", type: "text", nullable: true })
  errorMessage!: string | null;

  @Column({ name: "latency_ms", type: "integer", nullable: true })
  latencyMs!: number | null;

  @Column({ type: "enum", enum: ScreeningTrigger, enumName: "screening_trigger_enum" })
  trigger!: ScreeningTrigger;

  /** user_id for MANUAL; NULL for ONBOARDING/SCHEDULED/UPDATE (system-initiated). */
  @Column({ name: "triggered_by", type: "uuid", nullable: true })
  triggeredBy!: string | null;

  @Column({ name: "started_at", type: "timestamptz" })
  startedAt!: Date;

  @Column({ name: "completed_at", type: "timestamptz", nullable: true })
  completedAt!: Date | null;
}
