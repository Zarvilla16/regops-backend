import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/**
 * Per-tenant manual blacklist (Section 3.4). Names matched against this list
 * always return CONFIRMED_MATCH regardless of provider — InternalBlacklistProvider
 * is hard-wired to run first and short-circuits external provider calls on a hit.
 * No UI for managing this in v1 — direct DB insertion or a CLI tool.
 */
@Entity({ name: "internal_blacklist" })
export class InternalBlacklistEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "tenant_id", type: "uuid" })
  @Index()
  tenantId!: string;

  @Column({ name: "full_name", type: "varchar", length: 255 })
  fullName!: string;

  @Column({ type: "varchar", length: 11, nullable: true })
  bvn!: string | null;

  @Column({ type: "varchar", length: 11, nullable: true })
  nin!: string | null;

  @Column({ type: "text" })
  reason!: string;

  @Column({ name: "added_by", type: "uuid" })
  addedBy!: string;

  /** NULL = permanent. */
  @Column({ name: "expires_at", type: "timestamptz", nullable: true })
  expiresAt!: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
