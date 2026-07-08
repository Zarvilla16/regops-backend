import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds the Customer + Risk Rating schema: customer, risk_score_history,
 * risk_factor_config. Same RLS pattern as RowLevelSecurity1700000001000,
 * applied directly with the NULLIF(...) cast fix from
 * FixTenantIsolationEmptyStringCast1700000002000 (no need to reproduce that
 * bug and then re-fix it for these tables).
 */
export class CustomerAndRisk1700000010000 implements MigrationInterface {
  name = "CustomerAndRisk1700000010000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // pg_trgm: fuzzy full_name search. btree_gin: lets the uuid tenant_id
    // column participate in the same composite GIN index as the trigram
    // column below (core Postgres GIN has no built-in uuid opclass).
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS btree_gin;`);

    await queryRunner.query(`
      CREATE TYPE customer_type_enum AS ENUM (
        'INDIVIDUAL', 'SME', 'CORPORATE', 'NGO', 'GOVERNMENT', 'PEP'
      );
    `);
    await queryRunner.query(`
      CREATE TYPE customer_status_enum AS ENUM ('ACTIVE', 'DORMANT', 'BLOCKED', 'CLOSED');
    `);
    await queryRunner.query(`
      CREATE TYPE risk_level_enum AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
    `);
    await queryRunner.query(`
      CREATE TYPE score_trigger_enum AS ENUM (
        'INITIAL', 'SCHEDULED', 'MANUAL', 'SCREENING_MATCH', 'CUSTOMER_UPDATED'
      );
    `);
    await queryRunner.query(`
      CREATE TYPE risk_factor_type_enum AS ENUM (
        'CUSTOMER_TYPE', 'OCCUPATION', 'COUNTRY', 'PRODUCT_MIX',
        'TRANSACTION_VELOCITY', 'KYC_TIER'
      );
    `);

    await queryRunner.query(`
      CREATE TABLE customer (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        cbs_customer_id varchar(100) NOT NULL,
        bvn varchar(11),
        nin varchar(11),
        full_name varchar(255) NOT NULL,
        email varchar(255),
        phone varchar(20),
        date_of_birth date,
        customer_type customer_type_enum NOT NULL,
        occupation varchar(100),
        country varchar(2) NOT NULL DEFAULT 'NG',
        nationality varchar(2),
        kyc_tier smallint NOT NULL DEFAULT 1,
        risk_score smallint NOT NULL DEFAULT 0,
        risk_level risk_level_enum NOT NULL DEFAULT 'LOW',
        last_risk_calculated_at timestamptz,
        is_pep boolean NOT NULL DEFAULT false,
        is_sanctioned boolean NOT NULL DEFAULT false,
        last_screened_at timestamptz,
        status customer_status_enum NOT NULL DEFAULT 'ACTIVE',
        onboarded_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz
      );
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_customer_tenant_cbs_id ON customer (tenant_id, cbs_customer_id);
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_customer_tenant_bvn ON customer (tenant_id, bvn) WHERE bvn IS NOT NULL;
    `);
    await queryRunner.query(`
      CREATE INDEX idx_customer_tenant_risk_level ON customer (tenant_id, risk_level);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_customer_tenant_customer_type ON customer (tenant_id, customer_type);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_customer_tenant_fullname_trgm
        ON customer USING gin (tenant_id, full_name gin_trgm_ops);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_customer_tenant_last_risk_calculated_at
        ON customer (tenant_id, last_risk_calculated_at) WHERE deleted_at IS NULL;
    `);

    await queryRunner.query(`
      CREATE TABLE risk_score_history (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        customer_id uuid NOT NULL REFERENCES customer(id) ON DELETE CASCADE,
        score smallint NOT NULL,
        level risk_level_enum NOT NULL,
        factors jsonb NOT NULL,
        trigger score_trigger_enum NOT NULL,
        previous_score smallint,
        previous_level risk_level_enum,
        calculated_at timestamptz NOT NULL,
        calculated_by uuid
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_risk_score_history_customer_calculated_at
        ON risk_score_history (customer_id, calculated_at DESC);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_risk_score_history_tenant_calculated_at
        ON risk_score_history (tenant_id, calculated_at DESC);
    `);

    await queryRunner.query(`
      CREATE TABLE risk_factor_config (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        factor_type risk_factor_type_enum NOT NULL,
        weight decimal(4,2) NOT NULL DEFAULT 1.00,
        config jsonb NOT NULL,
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_risk_factor_config_tenant_type
        ON risk_factor_config (tenant_id, factor_type);
    `);

    // RLS — same tenant_isolation / super_admin_bypass pattern as
    // RowLevelSecurity1700000001000, with the NULLIF(...) fix applied
    // directly (see FixTenantIsolationEmptyStringCast1700000002000).
    const tables = ["customer", "risk_score_history", "risk_factor_config"];
    for (const table of tables) {
      await queryRunner.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
      await queryRunner.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
      await queryRunner.query(`
        CREATE POLICY tenant_isolation ON ${table}
          USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
      `);
      await queryRunner.query(`
        CREATE POLICY super_admin_bypass ON ${table}
          USING (current_setting('app.bypass_rls', true) = 'true');
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const tables = ["customer", "risk_score_history", "risk_factor_config"];
    for (const table of tables) {
      await queryRunner.query(`DROP POLICY IF EXISTS super_admin_bypass ON ${table};`);
      await queryRunner.query(`DROP POLICY IF EXISTS tenant_isolation ON ${table};`);
      await queryRunner.query(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY;`);
      await queryRunner.query(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;`);
    }

    await queryRunner.query(`DROP TABLE IF EXISTS risk_factor_config;`);
    await queryRunner.query(`DROP TABLE IF EXISTS risk_score_history;`);
    await queryRunner.query(`DROP TABLE IF EXISTS customer;`);

    await queryRunner.query(`DROP TYPE IF EXISTS risk_factor_type_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS score_trigger_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS risk_level_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS customer_status_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS customer_type_enum;`);
  }
}
