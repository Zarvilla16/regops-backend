import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds the Screening schema (Backend Prompt 3): screening_provider_config,
 * screening_check, screening_match, internal_blacklist. Same RLS pattern as
 * CustomerAndRisk1700000010000 (tenant_isolation / super_admin_bypass, with
 * the NULLIF(...) cast fix applied directly — see
 * FixTenantIsolationEmptyStringCast1700000002000 for why that fix exists in
 * the first place).
 */
export class Screening1700000020000 implements MigrationInterface {
  name = "Screening1700000020000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // pg_trgm already exists (created by CustomerAndRisk1700000010000) —
    // internal_blacklist.full_name reuses it for fuzzy matching, same as
    // customer.full_name.
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);

    await queryRunner.query(`
      CREATE TYPE screening_provider_name_enum AS ENUM ('SMILE_ID', 'PREMBLY', 'MOCK');
    `);
    await queryRunner.query(`
      CREATE TYPE screening_check_type_enum AS ENUM ('SANCTIONS', 'PEP', 'ADVERSE_MEDIA');
    `);
    await queryRunner.query(`
      CREATE TYPE screening_check_status_enum AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'TIMEOUT');
    `);
    await queryRunner.query(`
      CREATE TYPE screening_result_type_enum AS ENUM ('CLEAN', 'POTENTIAL_MATCH', 'CONFIRMED_MATCH', 'ERROR');
    `);
    await queryRunner.query(`
      CREATE TYPE screening_trigger_enum AS ENUM ('ONBOARDING', 'SCHEDULED', 'MANUAL', 'UPDATE');
    `);
    await queryRunner.query(`
      CREATE TYPE match_review_status_enum AS ENUM ('PENDING_REVIEW', 'REVIEWED');
    `);
    await queryRunner.query(`
      CREATE TYPE match_decision_enum AS ENUM ('TRUE_POSITIVE', 'FALSE_POSITIVE');
    `);

    // --- screening_provider_config -----------------------------------------
    await queryRunner.query(`
      CREATE TABLE screening_provider_config (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        provider screening_provider_name_enum NOT NULL,
        check_type screening_check_type_enum NOT NULL,
        is_primary boolean NOT NULL DEFAULT false,
        is_fallback boolean NOT NULL DEFAULT false,
        credentials_ref text NOT NULL,
        config jsonb NOT NULL DEFAULT '{}',
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_screening_provider_config_tenant ON screening_provider_config (tenant_id);
    `);
    // Only one primary per (tenant, check_type) — a partial unique index,
    // since plain UNIQUE(tenant_id, check_type, is_primary) would also
    // reject two different is_primary=false rows for the same check_type
    // (i.e. two non-primary configs), which is legal.
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_screening_provider_config_tenant_check_primary
        ON screening_provider_config (tenant_id, check_type)
        WHERE is_primary = true;
    `);

    // --- screening_check -----------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE screening_check (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        customer_id uuid REFERENCES customer(id) ON DELETE CASCADE,
        check_type screening_check_type_enum NOT NULL,
        provider screening_provider_name_enum NOT NULL,
        input_data jsonb NOT NULL,
        input_hash char(64) NOT NULL,
        status screening_check_status_enum NOT NULL,
        result screening_result_type_enum,
        highest_match_score smallint,
        provider_reference varchar(255),
        raw_response jsonb,
        error_message text,
        latency_ms integer,
        trigger screening_trigger_enum NOT NULL,
        triggered_by uuid,
        started_at timestamptz NOT NULL,
        completed_at timestamptz
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_screening_check_tenant ON screening_check (tenant_id);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_screening_check_customer ON screening_check (customer_id);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_screening_check_customer_type_started
        ON screening_check (customer_id, check_type, started_at DESC);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_screening_check_tenant_pending
        ON screening_check (tenant_id, status) WHERE status = 'PENDING';
    `);
    await queryRunner.query(`
      CREATE INDEX idx_screening_check_tenant_result_started
        ON screening_check (tenant_id, result, started_at DESC);
    `);
    // Section 5.5's dedup lookup: "same customer, same input_hash, within the
    // last hour" — this composite index is what makes that lookup an index
    // scan instead of a sequential scan as screening_check grows.
    await queryRunner.query(`
      CREATE INDEX idx_screening_check_customer_hash_started
        ON screening_check (customer_id, input_hash, started_at DESC);
    `);

    // --- screening_match -------------------------------------------------------
    // customer_id is nullable — see ScreeningMatchEntity's docblock: the
    // synchronous sanctions pre-screen at onboarding runs before the
    // Customer row exists, and a blocked onboarding still needs a match row
    // for the review trail (Section 10.3).
    await queryRunner.query(`
      CREATE TABLE screening_match (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        screening_check_id uuid NOT NULL REFERENCES screening_check(id) ON DELETE CASCADE,
        customer_id uuid REFERENCES customer(id) ON DELETE CASCADE,
        list_source varchar(100) NOT NULL,
        match_name varchar(255) NOT NULL,
        match_score smallint NOT NULL,
        match_data jsonb NOT NULL,
        review_status match_review_status_enum NOT NULL DEFAULT 'PENDING_REVIEW',
        decision match_decision_enum,
        decision_reason text,
        reviewed_by uuid,
        reviewed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_screening_match_tenant ON screening_match (tenant_id);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_screening_match_check ON screening_match (screening_check_id);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_screening_match_customer ON screening_match (customer_id);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_screening_match_tenant_pending_review
        ON screening_match (tenant_id, review_status) WHERE review_status = 'PENDING_REVIEW';
    `);

    // --- internal_blacklist ----------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE internal_blacklist (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        full_name varchar(255) NOT NULL,
        bvn varchar(11),
        nin varchar(11),
        reason text NOT NULL,
        added_by uuid NOT NULL,
        expires_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_internal_blacklist_tenant_fullname_trgm
        ON internal_blacklist USING gin (full_name gin_trgm_ops);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_internal_blacklist_tenant_bvn
        ON internal_blacklist (tenant_id, bvn) WHERE bvn IS NOT NULL;
    `);
    await queryRunner.query(`
      CREATE INDEX idx_internal_blacklist_tenant_nin
        ON internal_blacklist (tenant_id, nin) WHERE nin IS NOT NULL;
    `);

    // RLS — same tenant_isolation / super_admin_bypass pattern as
    // CustomerAndRisk1700000010000, NULLIF(...) fix applied directly.
    const tables = ["screening_provider_config", "screening_check", "screening_match", "internal_blacklist"];
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
    const tables = ["screening_provider_config", "screening_check", "screening_match", "internal_blacklist"];
    for (const table of tables) {
      await queryRunner.query(`DROP POLICY IF EXISTS super_admin_bypass ON ${table};`);
      await queryRunner.query(`DROP POLICY IF EXISTS tenant_isolation ON ${table};`);
      await queryRunner.query(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY;`);
      await queryRunner.query(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;`);
    }

    await queryRunner.query(`DROP TABLE IF EXISTS internal_blacklist;`);
    await queryRunner.query(`DROP TABLE IF EXISTS screening_match;`);
    await queryRunner.query(`DROP TABLE IF EXISTS screening_check;`);
    await queryRunner.query(`DROP TABLE IF EXISTS screening_provider_config;`);

    await queryRunner.query(`DROP TYPE IF EXISTS match_decision_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS match_review_status_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS screening_trigger_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS screening_result_type_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS screening_check_status_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS screening_check_type_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS screening_provider_name_enum;`);
  }
}
