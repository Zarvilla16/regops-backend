import { Column, Entity, Index, PrimaryColumn } from "typeorm";

/**
 * Maps to the `audit_log` table, which is RANGE-partitioned by `created_at`.
 * Postgres requires unique/primary constraints on a partitioned table to
 * include the partition key, hence the composite (id, created_at) primary key
 * instead of a single `id` primary column.
 */
@Entity({ name: "audit_log" })
export class AuditLogEntity {
  @PrimaryColumn({ type: "uuid", default: () => "gen_random_uuid()" })
  id!: string;

  @PrimaryColumn({ name: "created_at", type: "timestamptz", default: () => "now()" })
  createdAt!: Date;

  @Column({ name: "tenant_id", type: "uuid" })
  @Index()
  tenantId!: string;

  @Column({ name: "user_id", type: "uuid", nullable: true })
  userId!: string | null;

  @Column({ type: "varchar", length: 100 })
  action!: string;

  @Column({ name: "entity_type", type: "varchar", length: 100 })
  entityType!: string;

  @Column({ name: "entity_id", type: "uuid", nullable: true })
  entityId!: string | null;

  @Column({ name: "before_state", type: "jsonb", nullable: true })
  beforeState!: Record<string, unknown> | null;

  @Column({ name: "after_state", type: "jsonb", nullable: true })
  afterState!: Record<string, unknown> | null;

  @Column({ name: "ip_address", type: "inet", nullable: true })
  ipAddress!: string | null;

  @Column({ name: "user_agent", type: "text", nullable: true })
  userAgent!: string | null;
}
