import { Column, CreateDateColumn, Entity, Index, JoinColumn, OneToOne, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
import { PepCategory, PepStatus } from "@regops/shared";
import { CustomerEntity } from "./customer.entity";

/**
 * One-to-one with Customer, only populated when a customer is a PEP (Backend
 * Prompt 3.5, Section 1) — separate table rather than new columns on
 * `customer`, since these fields are meaningless for the overwhelming
 * majority of non-PEP customers and would otherwise be a wide block of
 * always-null columns on the hot path table. Created in the same
 * transaction as the Customer row when `customerType === PEP` or
 * `isPep === true` is supplied at creation (see CustomersService.create);
 * `eddApprovedBy`/`eddApprovedAt` are populated later, by
 * POST /customers/:id/approve-pep.
 */
@Entity({ name: "pep_details" })
export class PepDetailsEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "customer_id", type: "uuid" })
  @Index({ unique: true })
  customerId!: string;

  @OneToOne(() => CustomerEntity, { onDelete: "CASCADE" })
  @JoinColumn({ name: "customer_id" })
  customer?: CustomerEntity;

  @Column({ name: "tenant_id", type: "uuid" })
  @Index()
  tenantId!: string;

  @Column({
    name: "pep_category",
    type: "enum",
    enum: PepCategory,
    enumName: "pep_category_enum",
  })
  pepCategory!: PepCategory;

  @Column({ name: "pep_position", type: "varchar", length: 255 })
  pepPosition!: string;

  @Column({ name: "pep_institution", type: "varchar", length: 255 })
  pepInstitution!: string;

  /** ISO 3166-1 alpha-2. */
  @Column({ name: "pep_country", type: "varchar", length: 2 })
  pepCountry!: string;

  @Column({
    name: "pep_status",
    type: "enum",
    enum: PepStatus,
    enumName: "pep_status_enum",
  })
  pepStatus!: PepStatus;

  @Column({ name: "pep_start_date", type: "date" })
  pepStartDate!: Date;

  /** Null means still current — see PepStatus's own docblock for why status is a separate field. */
  @Column({ name: "pep_end_date", type: "date", nullable: true })
  pepEndDate!: Date | null;

  @Column({ name: "is_pep_by_association", type: "boolean", default: false })
  isPepByAssociation!: boolean;

  /** Populated only when isPepByAssociation is true — enforced at the DTO layer (@ValidateIf), not the DB. */
  @Column({ name: "associated_pep_name", type: "varchar", length: 255, nullable: true })
  associatedPepName!: string | null;

  @Column({ name: "source_of_wealth", type: "text" })
  sourceOfWealth!: string;

  @Column({ name: "edd_approved_by", type: "uuid", nullable: true })
  eddApprovedBy!: string | null;

  @Column({ name: "edd_approved_at", type: "timestamptz", nullable: true })
  eddApprovedAt!: Date | null;

  @Column({ name: "next_review_date", type: "date" })
  nextReviewDate!: Date;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
