import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { UserRole, UserStatus } from "@regops/shared";
import { TenantEntity } from "./tenant.entity";

// Note: the enforced uniqueness constraint is a functional index on
// (tenant_id, lower(email)) created directly in the InitialSchema migration,
// since TypeORM decorators cannot express functional indexes.
@Entity({ name: "user" })
export class UserEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "tenant_id", type: "uuid" })
  @Index()
  tenantId!: string;

  @ManyToOne(() => TenantEntity, { onDelete: "CASCADE" })
  @JoinColumn({ name: "tenant_id" })
  tenant?: TenantEntity;

  @Column({ type: "varchar", length: 255 })
  email!: string;

  @Column({ name: "password_hash", type: "text" })
  passwordHash!: string;

  @Column({ name: "full_name", type: "varchar", length: 255 })
  fullName!: string;

  @Column({ type: "enum", enum: UserRole, enumName: "user_role_enum" })
  role!: UserRole;

  @Column({
    type: "enum",
    enum: UserStatus,
    enumName: "user_status_enum",
    default: UserStatus.INVITED,
  })
  status!: UserStatus;

  @Column({ name: "mfa_enabled", type: "boolean", default: false })
  mfaEnabled!: boolean;

  @Column({ name: "mfa_secret", type: "text", nullable: true })
  mfaSecret!: string | null;

  /** Set when an admin created the account with a temporary password; cleared by /auth/change-password. */
  @Column({ name: "must_change_password", type: "boolean", default: false })
  mustChangePassword!: boolean;

  @Column({ name: "last_login_at", type: "timestamptz", nullable: true })
  lastLoginAt!: Date | null;

  @Column({ name: "failed_login_count", type: "int", default: 0 })
  failedLoginCount!: number;

  @Column({ name: "locked_until", type: "timestamptz", nullable: true })
  lockedUntil!: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;

  @DeleteDateColumn({ name: "deleted_at", type: "timestamptz", nullable: true })
  deletedAt!: Date | null;
}
