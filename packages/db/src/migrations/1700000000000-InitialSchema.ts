import { MigrationInterface, QueryRunner } from "typeorm";

export class InitialSchema1700000000000 implements MigrationInterface {
  name = "InitialSchema1700000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

    await queryRunner.query(`
      CREATE TYPE tenant_type_enum AS ENUM ('MFB', 'FINTECH', 'PSP', 'MMO');
    `);
    await queryRunner.query(`
      CREATE TYPE tenant_status_enum AS ENUM ('ACTIVE', 'SUSPENDED', 'PENDING');
    `);
    await queryRunner.query(`
      CREATE TYPE user_role_enum AS ENUM (
        'SUPER_ADMIN', 'TENANT_ADMIN', 'COMPLIANCE_OFFICER', 'INVESTIGATOR', 'VIEWER'
      );
    `);
    await queryRunner.query(`
      CREATE TYPE user_status_enum AS ENUM ('ACTIVE', 'INVITED', 'SUSPENDED');
    `);

    await queryRunner.query(`
      CREATE TABLE tenant (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name varchar(255) NOT NULL,
        type tenant_type_enum NOT NULL,
        cbn_license_number varchar(100),
        status tenant_status_enum NOT NULL DEFAULT 'PENDING',
        config jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz
      );
    `);

    await queryRunner.query(`
      CREATE TABLE "user" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
        email varchar(255) NOT NULL,
        password_hash text NOT NULL,
        full_name varchar(255) NOT NULL,
        role user_role_enum NOT NULL,
        status user_status_enum NOT NULL DEFAULT 'INVITED',
        mfa_enabled boolean NOT NULL DEFAULT false,
        mfa_secret text,
        last_login_at timestamptz,
        failed_login_count int NOT NULL DEFAULT 0,
        locked_until timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz
      );
    `);
    await queryRunner.query(`CREATE INDEX idx_user_tenant_id ON "user" (tenant_id);`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_user_tenant_email ON "user" (tenant_id, lower(email));
    `);

    await queryRunner.query(`
      CREATE TABLE refresh_token (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
        token_hash text NOT NULL,
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz,
        replaced_by_id uuid,
        ip_address inet,
        user_agent text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(
      `CREATE INDEX idx_refresh_token_user_id ON refresh_token (user_id);`,
    );

    // audit_log is RANGE-partitioned by created_at; the primary key must
    // include the partition key, hence the composite (id, created_at).
    await queryRunner.query(`
      CREATE TABLE audit_log (
        id uuid NOT NULL DEFAULT gen_random_uuid(),
        created_at timestamptz NOT NULL DEFAULT now(),
        tenant_id uuid NOT NULL,
        user_id uuid,
        action varchar(100) NOT NULL,
        entity_type varchar(100) NOT NULL,
        entity_id uuid,
        before_state jsonb,
        after_state jsonb,
        ip_address inet,
        user_agent text,
        PRIMARY KEY (id, created_at)
      ) PARTITION BY RANGE (created_at);
    `);
    await queryRunner.query(`CREATE INDEX idx_audit_log_tenant_id ON audit_log (tenant_id);`);

    // Helper function: idempotently creates the quarterly partition of
    // audit_log covering `for_date`. A recurring job (see apps/worker) calls
    // this ahead of time so partitions always exist before they're needed.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION create_audit_log_partition(for_date date)
      RETURNS void AS $$
      DECLARE
        quarter_start date := date_trunc('quarter', for_date)::date;
        quarter_end date := (date_trunc('quarter', for_date) + interval '3 months')::date;
        partition_name text := 'audit_log_' || to_char(quarter_start, 'YYYY') || '_q'
          || to_char(quarter_start, 'Q');
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = partition_name) THEN
          EXECUTE format(
            'CREATE TABLE %I PARTITION OF audit_log FOR VALUES FROM (%L) TO (%L)',
            partition_name, quarter_start, quarter_end
          );
        END IF;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // Pre-create the current quarter plus 3 quarters ahead.
    await queryRunner.query(`
      DO $$
      DECLARE
        i int;
      BEGIN
        FOR i IN 0..3 LOOP
          PERFORM create_audit_log_partition((now() + (i * interval '3 months'))::date);
        END LOOP;
      END;
      $$;
    `);

    await queryRunner.query(`
      CREATE TABLE idempotency_key (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        key varchar(255) NOT NULL,
        request_hash text NOT NULL,
        response_status int NOT NULL,
        response_body jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL
      );
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_idempotency_tenant_key ON idempotency_key (tenant_id, key);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS idempotency_key;`);
    await queryRunner.query(`DROP TABLE IF EXISTS audit_log CASCADE;`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS create_audit_log_partition(date);`);
    await queryRunner.query(`DROP TABLE IF EXISTS refresh_token;`);
    await queryRunner.query(`DROP TABLE IF EXISTS "user";`);
    await queryRunner.query(`DROP TABLE IF EXISTS tenant;`);
    await queryRunner.query(`DROP TYPE IF EXISTS user_status_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS user_role_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS tenant_status_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS tenant_type_enum;`);
  }
}
