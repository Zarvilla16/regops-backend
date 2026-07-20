import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";
import { RuleReplayStatus } from "@regops/shared";

/**
 * Tracks progress of a `pnpm cli:rule-replay` invocation (Section 10) so
 * GET /rules/replays/:replayId (served by the live apps/api process) can
 * observe a run happening in a *separate* CLI process — same reason
 * IngestionBatchEntity exists (a DB row is the only IPC channel between the
 * process doing the work and the process answering the status query).
 */
@Entity({ name: "rule_replay" })
export class RuleReplayEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "tenant_id", type: "uuid" })
  @Index()
  tenantId!: string;

  /** Null means "all active rules for the tenant" (Section 10.2's first CLI form). */
  @Column({ name: "rule_id", type: "uuid", nullable: true })
  ruleId!: string | null;

  @Column({ name: "from_date", type: "date" })
  fromDate!: Date;

  @Column({ name: "to_date", type: "date" })
  toDate!: Date;

  @Column({ name: "dry_run", type: "boolean", default: false })
  dryRun!: boolean;

  @Column({ type: "enum", enum: RuleReplayStatus, enumName: "rule_replay_status_enum", default: RuleReplayStatus.QUEUED })
  status!: RuleReplayStatus;

  @Column({ name: "total_transactions", type: "integer", default: 0 })
  totalTransactions!: number;

  @Column({ name: "processed_transactions", type: "integer", default: 0 })
  processedTransactions!: number;

  @Column({ name: "fired_count", type: "integer", default: 0 })
  firedCount!: number;

  /** FileStorage key of the dry-run CSV report, when produced. */
  @Column({ name: "report_key", type: "text", nullable: true })
  reportKey!: string | null;

  @Column({ name: "started_at", type: "timestamptz", nullable: true })
  startedAt!: Date | null;

  @Column({ name: "completed_at", type: "timestamptz", nullable: true })
  completedAt!: Date | null;

  @Column({ name: "error_message", type: "text", nullable: true })
  errorMessage!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
