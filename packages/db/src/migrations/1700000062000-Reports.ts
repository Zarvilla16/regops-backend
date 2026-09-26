import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Backend Prompt 7 — extends the Prompt 6 `report` stub (1700000060000-Cases.ts)
 * into the real SAR/CTR table. Forward-only follow-up migration, same
 * convention as 1700000061000: the original Prompt 6 migration is not edited.
 *
 * RLS: `report` already has ENABLE/FORCE ROW LEVEL SECURITY and the
 * tenant_isolation policy from 1700000060000 — nothing to add here, new
 * columns are covered automatically.
 *
 * Enum note: ALTER TYPE ... ADD VALUE is allowed inside a transaction on
 * Postgres 12+, but the new value cannot be *referenced* until that
 * transaction commits. ck_report_subject therefore compares report_type::text
 * rather than using the 'CTR' enum literal.
 */
export class Reports1700000062000 implements MigrationInterface {
  name = "Reports1700000062000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE report_type_enum ADD VALUE IF NOT EXISTS 'CTR';`);
    await queryRunner.query(`ALTER TYPE report_status_enum ADD VALUE IF NOT EXISTS 'PENDING_CONFIRMATION';`);
    await queryRunner.query(`ALTER TYPE report_status_enum ADD VALUE IF NOT EXISTS 'SUBMITTED';`);

    // The two NOT NULL -> nullable changes: case_id (CTRs have no case) and generated_by (CTRs are system-generated).
    await queryRunner.query(`ALTER TABLE report ALTER COLUMN case_id DROP NOT NULL;`);
    await queryRunner.query(`ALTER TABLE report ALTER COLUMN generated_by DROP NOT NULL;`);

    await queryRunner.query(`
      ALTER TABLE report
        ADD COLUMN transaction_id uuid,
        ADD COLUMN flagged_amount numeric(20,2),
        ADD COLUMN narrative text,
        ADD COLUMN submitted_by uuid,
        ADD COLUMN submitted_at timestamptz,
        ADD COLUMN confirmed_by uuid,
        ADD COLUMN confirmed_at timestamptz,
        ADD COLUMN nfiu_reference text;
    `);

    // One SAR per case (was a plain unique index) / one CTR per transaction.
    await queryRunner.query(`DROP INDEX IF EXISTS uq_report_case_id;`);
    await queryRunner.query(`CREATE UNIQUE INDEX uq_report_case_id ON report (case_id) WHERE case_id IS NOT NULL;`);
    await queryRunner.query(`CREATE UNIQUE INDEX uq_report_transaction_id ON report (transaction_id) WHERE transaction_id IS NOT NULL;`);

    await queryRunner.query(`
      ALTER TABLE report ADD CONSTRAINT ck_report_subject CHECK (
        (report_type::text = 'SAR' AND case_id IS NOT NULL AND transaction_id IS NULL)
        OR (report_type::text = 'CTR' AND transaction_id IS NOT NULL AND case_id IS NULL)
      );
    `);

    await queryRunner.query(`CREATE INDEX idx_report_tenant_status ON report (tenant_id, status);`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_report_tenant_status;`);
    await queryRunner.query(`ALTER TABLE report DROP CONSTRAINT IF EXISTS ck_report_subject;`);
    // CTR rows cannot survive: case_id must go back to NOT NULL.
    await queryRunner.query(`DELETE FROM report WHERE report_type::text = 'CTR';`);
    await queryRunner.query(`DROP INDEX IF EXISTS uq_report_transaction_id;`);
    await queryRunner.query(`DROP INDEX IF EXISTS uq_report_case_id;`);
    await queryRunner.query(`CREATE UNIQUE INDEX uq_report_case_id ON report (case_id);`);
    await queryRunner.query(`
      ALTER TABLE report
        DROP COLUMN nfiu_reference,
        DROP COLUMN confirmed_at,
        DROP COLUMN confirmed_by,
        DROP COLUMN submitted_at,
        DROP COLUMN submitted_by,
        DROP COLUMN narrative,
        DROP COLUMN flagged_amount,
        DROP COLUMN transaction_id;
    `);
    // Existing rows always have generated_by (only CTRs, now deleted, could lack it).
    await queryRunner.query(`ALTER TABLE report ALTER COLUMN generated_by SET NOT NULL;`);
    await queryRunner.query(`ALTER TABLE report ALTER COLUMN case_id SET NOT NULL;`);
    // Postgres cannot drop enum values; 'CTR' / 'PENDING_CONFIRMATION' / 'SUBMITTED' remain in the types (harmless, unused).
  }
}
