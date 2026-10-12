import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

export enum PasswordTokenPurpose {
  RESET = "RESET",
  INVITE = "INVITE",
}

/** See migration 1700000070000-PasswordTokens for why this table has no tenant_id / RLS. */
@Entity({ name: "password_token" })
export class PasswordTokenEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "user_id", type: "uuid" })
  @Index()
  userId!: string;

  @Column({ type: "enum", enum: PasswordTokenPurpose, enumName: "password_token_purpose_enum" })
  purpose!: PasswordTokenPurpose;

  /** SHA-256 hex of the token that was e-mailed; the token itself is never stored. */
  @Column({ name: "token_hash", type: "text", unique: true })
  tokenHash!: string;

  @Column({ name: "expires_at", type: "timestamptz" })
  expiresAt!: Date;

  @Column({ name: "used_at", type: "timestamptz", nullable: true })
  usedAt!: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
