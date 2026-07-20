import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
import { AccountStatus, AccountType } from "@regops/shared";

/**
 * Maps a Customer to their account numbers (one Customer -> many accounts).
 * Populated either explicitly (POST /customer-accounts) or lazily on first
 * transaction referencing an unseen account_number (spec Section 5.7).
 */
@Entity({ name: "customer_account" })
export class CustomerAccountEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "tenant_id", type: "uuid" })
  @Index()
  tenantId!: string;

  @Column({ name: "customer_id", type: "uuid" })
  @Index()
  customerId!: string;

  @Column({ name: "account_number", type: "varchar", length: 50 })
  accountNumber!: string;

  @Column({ name: "account_type", type: "enum", enum: AccountType, enumName: "account_type_enum", default: AccountType.SAVINGS })
  accountType!: AccountType;

  @Column({ name: "account_name", type: "varchar", length: 255, nullable: true })
  accountName!: string | null;

  @Column({ type: "enum", enum: AccountStatus, enumName: "account_status_enum", default: AccountStatus.ACTIVE })
  status!: AccountStatus;

  /** Last known balance, not authoritative — occasionally refreshed from
   * transaction.balance_after, never the source of truth for account balance. */
  @Column({ type: "numeric", precision: 18, scale: 2, nullable: true })
  balance!: string | null;

  @Column({ name: "balance_as_of", type: "timestamptz", nullable: true })
  balanceAsOf!: Date | null;

  @Column({ name: "opened_at", type: "timestamptz", nullable: true })
  openedAt!: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
