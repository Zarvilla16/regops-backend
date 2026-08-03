import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Entity({ name: "case_note" })
export class CaseNoteEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "tenant_id", type: "uuid" })
  @Index()
  tenantId!: string;

  @Column({ name: "case_id", type: "uuid" })
  @Index()
  caseId!: string;

  @Column({ name: "user_id", type: "uuid" })
  userId!: string;

  @Column({ type: "text" })
  content!: string;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
