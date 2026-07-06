import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Entity({ name: "idempotency_key" })
@Index("uq_idempotency_tenant_key", ["tenantId", "key"], { unique: true })
export class IdempotencyKeyEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "tenant_id", type: "uuid" })
  tenantId!: string;

  @Column({ type: "varchar", length: 255 })
  key!: string;

  @Column({ name: "request_hash", type: "text" })
  requestHash!: string;

  @Column({ name: "response_status", type: "int" })
  responseStatus!: number;

  @Column({ name: "response_body", type: "jsonb" })
  responseBody!: unknown;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @Column({ name: "expires_at", type: "timestamptz" })
  expiresAt!: Date;
}
