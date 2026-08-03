import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/** file_key is the FileStorage key (Section 2.5), not a browsable URL — same
 * "proxy through an authenticated API route" convention as Customer.photoUrl. */
@Entity({ name: "case_evidence" })
export class CaseEvidenceEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "tenant_id", type: "uuid" })
  @Index()
  tenantId!: string;

  @Column({ name: "case_id", type: "uuid" })
  @Index()
  caseId!: string;

  @Column({ name: "file_name", type: "text" })
  fileName!: string;

  @Column({ name: "file_key", type: "text" })
  fileKey!: string;

  @Column({ name: "file_type", type: "varchar", length: 255 })
  fileType!: string;

  @Column({ name: "file_size_bytes", type: "integer" })
  fileSizeBytes!: number;

  @Column({ name: "uploaded_by", type: "uuid" })
  uploadedBy!: string;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
