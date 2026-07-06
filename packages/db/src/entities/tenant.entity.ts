import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { TenantStatus, TenantType } from "@regops/shared";

@Entity({ name: "tenant" })
export class TenantEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 255 })
  name!: string;

  @Column({ type: "enum", enum: TenantType, enumName: "tenant_type_enum" })
  type!: TenantType;

  @Column({ name: "cbn_license_number", type: "varchar", length: 100, nullable: true })
  cbnLicenseNumber!: string | null;

  @Column({
    type: "enum",
    enum: TenantStatus,
    enumName: "tenant_status_enum",
    default: TenantStatus.PENDING,
  })
  status!: TenantStatus;

  @Column({ type: "jsonb", default: {} })
  config!: Record<string, unknown>;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;

  @DeleteDateColumn({ name: "deleted_at", type: "timestamptz", nullable: true })
  deletedAt!: Date | null;
}
