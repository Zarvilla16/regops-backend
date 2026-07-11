import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Backend Prompt 3.5 (Customer module enhancements): pep_details table,
 * customer.photo_url column, and a new CustomerStatus value
 * (PENDING_EDD_APPROVAL). Same RLS pattern as CustomerAndRisk1700000010000/
 * Screening1700000020000 (tenant_isolation / super_admin_bypass, NULLIF(...)
 * cast applied directly).
 */
export class CustomerEnhancements1700000030000 implements MigrationInterface {
  name = "CustomerEnhancements1700000030000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Postgres 12+ allows ALTER TYPE ... ADD VALUE inside a transaction as
    // long as the new value isn't also used within that same transaction —
    // this migration only adds it, never queries against it, so it's safe
    // run through TypeORM's default transactional migration runner.
    await queryRunner.query(`ALTER TYPE customer_status_enum ADD VALUE 'PENDING_EDD_APPROVAL';`);

    await queryRunner.query(`ALTER TABLE customer ADD COLUMN photo_url varchar(500);`);

    await queryRunner.query(`
      CREATE TYPE pep_category_enum AS ENUM ('DOMESTIC', 'FOREIGN', 'INTERNATIONAL_ORG');
    `);
    await queryRunner.query(`
      CREATE TYPE pep_status_enum AS ENUM ('CURRENT', 'FORMER');
    `);

    await queryRunner.query(`
      CREATE TABLE pep_details (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id uuid NOT NULL UNIQUE REFERENCES customer(id) ON DELETE CASCADE,
        tenant_id uuid NOT NULL,
        pep_category pep_category_enum NOT NULL,
        pep_position varchar(255) NOT NULL,
        pep_institution varchar(255) NOT NULL,
        pep_country varchar(2) NOT NULL,
        pep_status pep_status_enum NOT NULL,
        pep_start_date date NOT NULL,
        pep_end_date date,
        is_pep_by_association boolean NOT NULL DEFAULT false,
        associated_pep_name varchar(255),
        source_of_wealth text NOT NULL,
        edd_approved_by uuid REFERENCES "user"(id),
        edd_approved_at timestamptz,
        next_review_date date NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_pep_details_tenant ON pep_details (tenant_id);
    `);

    await queryRunner.query(`ALTER TABLE pep_details ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE pep_details FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON pep_details
        USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
    `);
    await queryRunner.query(`
      CREATE POLICY super_admin_bypass ON pep_details
        USING (current_setting('app.bypass_rls', true) = 'true');
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP POLICY IF EXISTS super_admin_bypass ON pep_details;`);
    await queryRunner.query(`DROP POLICY IF EXISTS tenant_isolation ON pep_details;`);
    await queryRunner.query(`ALTER TABLE pep_details NO FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE pep_details DISABLE ROW LEVEL SECURITY;`);

    await queryRunner.query(`DROP TABLE IF EXISTS pep_details;`);
    await queryRunner.query(`DROP TYPE IF EXISTS pep_status_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS pep_category_enum;`);

    await queryRunner.query(`ALTER TABLE customer DROP COLUMN IF EXISTS photo_url;`);

    // Postgres has no ALTER TYPE ... DROP VALUE — PENDING_EDD_APPROVAL can't
    // be cleanly removed from customer_status_enum without recreating the
    // type and rewriting every dependent column, which risks data loss if
    // any row is actually using it. Left in place deliberately; a fully
    // reversible down() would need to fail loudly if any row still has this
    // status, which is more machinery than this rollback path has needed for
    // any other migration so far. Documented in HANDOFF.md.
  }
}
