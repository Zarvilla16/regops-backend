import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Backend Prompt 4: transaction (partitioned), customer_account,
 * ingestion_batch. `transaction` is by far the largest table in the system,
 * so it's RANGE-partitioned by occurred_at, monthly — same idempotent
 * partition-creation-function pattern as audit_log's quarterly partitioning
 * (InitialSchema1700000000000), just monthly instead of quarterly and with a
 * DEFAULT partition instead of pre-creating a fixed lookback window.
 *
 * customer_id / counterparty_customer_id / account_number are FK-by-convention
 * only (no REFERENCES) — same choice already made for screening_check.customer_id:
 * RLS is what enforces tenant isolation here, not referential integrity, and a
 * real FK from a partitioned table adds constraint-maintenance cost for no
 * additional safety this schema needs.
 */
export class Transactions1700000040000 implements MigrationInterface {
  name = "Transactions1700000040000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Adds a value to customer_status_enum (owned by CustomerAndRisk1700000010000)
    // for the auto_create_stub ingestion mode (Section 5.6). Safe inside this
    // migration's transaction: PG12+ allows ALTER TYPE ... ADD VALUE in a
    // transaction as long as the new value isn't used in that same
    // transaction, and nothing here inserts a customer row. Postgres has no
    // "remove enum value" operation, so down() cannot cleanly undo this —
    // the value simply stays defined (harmless) after a revert.
    await queryRunner.query(`ALTER TYPE customer_status_enum ADD VALUE IF NOT EXISTS 'PENDING_KYC';`);
    // Same reasoning, for the re-score debounce trigger (Section 9.4) —
    // owned by CustomerAndRisk1700000010000's score_trigger_enum.
    await queryRunner.query(`ALTER TYPE score_trigger_enum ADD VALUE IF NOT EXISTS 'TRANSACTION_ACTIVITY';`);

    await queryRunner.query(`
      CREATE TYPE transaction_type_enum AS ENUM ('CREDIT', 'DEBIT');
    `);
    await queryRunner.query(`
      CREATE TYPE transaction_channel_enum AS ENUM (
        'BRANCH', 'MOBILE', 'USSD', 'POS', 'AGENT', 'TRANSFER', 'CASH', 'CARD', 'ATM', 'API', 'OTHER'
      );
    `);
    await queryRunner.query(`
      CREATE TYPE transaction_source_enum AS ENUM ('SFTP', 'WEBHOOK', 'MANUAL', 'BACKFILL');
    `);
    await queryRunner.query(`
      CREATE TYPE account_type_enum AS ENUM ('SAVINGS', 'CURRENT', 'LOAN', 'FIXED_DEPOSIT', 'WALLET', 'OTHER');
    `);
    await queryRunner.query(`
      CREATE TYPE account_status_enum AS ENUM ('ACTIVE', 'DORMANT', 'BLOCKED', 'CLOSED');
    `);
    await queryRunner.query(`
      CREATE TYPE ingestion_batch_status_enum AS ENUM (
        'QUEUED', 'PROCESSING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED'
      );
    `);

    // --- customer_account ---------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE customer_account (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        customer_id uuid NOT NULL,
        account_number varchar(50) NOT NULL,
        account_type account_type_enum NOT NULL DEFAULT 'SAVINGS',
        account_name varchar(255),
        status account_status_enum NOT NULL DEFAULT 'ACTIVE',
        balance numeric(18,2),
        balance_as_of timestamptz,
        opened_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_customer_account_tenant_account_number
        ON customer_account (tenant_id, account_number);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_customer_account_tenant_customer
        ON customer_account (tenant_id, customer_id);
    `);

    // --- ingestion_batch ------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE ingestion_batch (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        source transaction_source_enum NOT NULL,
        source_reference varchar(500),
        status ingestion_batch_status_enum NOT NULL,
        total_rows integer NOT NULL DEFAULT 0,
        processed_rows integer NOT NULL DEFAULT 0,
        succeeded_rows integer NOT NULL DEFAULT 0,
        failed_rows integer NOT NULL DEFAULT 0,
        error_report_url text,
        started_at timestamptz,
        completed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_ingestion_batch_tenant_created_at
        ON ingestion_batch (tenant_id, created_at DESC);
    `);

    // --- transaction (partitioned) --------------------------------------------
    // Composite PK (id, occurred_at) is required by Postgres for any unique
    // constraint on a partitioned table — it must include the partition key.
    await queryRunner.query(`
      CREATE TABLE transaction (
        id uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        cbs_transaction_id varchar(100) NOT NULL,
        customer_id uuid NOT NULL,
        account_number varchar(50) NOT NULL,

        amount numeric(18,2) NOT NULL,
        currency char(3) NOT NULL DEFAULT 'NGN',
        type transaction_type_enum NOT NULL,
        channel transaction_channel_enum NOT NULL,

        counterparty_account varchar(50),
        counterparty_bank varchar(20),
        counterparty_name varchar(255),
        counterparty_customer_id uuid,

        narration text,
        reference varchar(100),
        balance_after numeric(18,2),

        occurred_at timestamptz NOT NULL,
        ingested_at timestamptz NOT NULL DEFAULT now(),
        source transaction_source_enum NOT NULL,
        ingestion_batch_id uuid,

        PRIMARY KEY (id, occurred_at)
      ) PARTITION BY RANGE (occurred_at);
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_transaction_tenant_cbs_id_occurred_at
        ON transaction (tenant_id, cbs_transaction_id, occurred_at);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_transaction_tenant_customer_occurred_at
        ON transaction (tenant_id, customer_id, occurred_at DESC);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_transaction_tenant_account_occurred_at
        ON transaction (tenant_id, account_number, occurred_at DESC);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_transaction_tenant_counterparty_account_occurred_at
        ON transaction (tenant_id, counterparty_account, occurred_at DESC)
        WHERE counterparty_account IS NOT NULL;
    `);
    await queryRunner.query(`
      CREATE INDEX idx_transaction_tenant_occurred_at
        ON transaction (tenant_id, occurred_at DESC);
    `);

    // Helper function: idempotently creates the calendar-month partition of
    // `transaction` covering `for_date`. PartitionMaintenanceService (worker,
    // monthly on the 25th) calls this ahead of time so partitions always exist
    // before they're needed — see create_audit_log_partition for the
    // quarterly precedent this mirrors.
    //
    // IMPORTANT: unlike policies (which Postgres does apply automatically to
    // every partition once defined on the parent), ENABLE/FORCE ROW LEVEL
    // SECURITY are per-relation flags that do NOT propagate from a
    // partitioned parent to its partitions — each partition starts with RLS
    // OFF regardless of the parent's setting. A direct query against a named
    // partition (not routed through the parent) would silently skip RLS
    // entirely without this. Every partition this function creates gets its
    // own ENABLE/FORCE, mirroring the parent's tenant_isolation/
    // super_admin_bypass policies (which DO apply automatically once the
    // relation-level flags are on).
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION create_transaction_partition(for_date date)
      RETURNS void AS $$
      DECLARE
        month_start date := date_trunc('month', for_date)::date;
        month_end date := (date_trunc('month', for_date) + interval '1 month')::date;
        partition_name text := 'transaction_' || to_char(month_start, 'YYYY_MM');
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = partition_name) THEN
          EXECUTE format(
            'CREATE TABLE %I PARTITION OF transaction FOR VALUES FROM (%L) TO (%L)',
            partition_name, month_start, month_end
          );
          EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', partition_name);
          EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', partition_name);
        END IF;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // Pre-create the current month plus 5 months ahead (6 total).
    await queryRunner.query(`
      DO $$
      DECLARE
        i int;
      BEGIN
        FOR i IN 0..5 LOOP
          PERFORM create_transaction_partition((now() + (i * interval '1 month'))::date);
        END LOOP;
      END;
      $$;
    `);

    // Out-of-range rows (e.g. a corrupt occurred_at far in the future) land
    // here instead of failing the insert outright — silently destroys query
    // performance if it ever fills up, hence "alert-and-investigate later"
    // rather than "reject at insert time" (spec's own call).
    await queryRunner.query(`
      CREATE TABLE transaction_default PARTITION OF transaction DEFAULT;
    `);
    await queryRunner.query(`ALTER TABLE transaction_default ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE transaction_default FORCE ROW LEVEL SECURITY;`);

    // RLS on the parent — policies apply to every partition (present and
    // future) automatically once defined here, but the ENABLE/FORCE flags
    // themselves do not (see create_transaction_partition's docblock above,
    // and transaction_default's explicit ALTERs just above) — verified
    // directly against a named partition table in transactions.e2e-spec.ts,
    // not just the parent.
    const plainTables = ["customer_account", "ingestion_batch"];
    for (const table of plainTables) {
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

    await queryRunner.query(`ALTER TABLE transaction ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE transaction FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON transaction
        USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
    `);
    await queryRunner.query(`
      CREATE POLICY super_admin_bypass ON transaction
        USING (current_setting('app.bypass_rls', true) = 'true');
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // customer_status_enum's PENDING_KYC and score_trigger_enum's
    // TRANSACTION_ACTIVITY values are NOT removed — Postgres has
    // no "drop enum value" operation (see the comment in up()).
    await queryRunner.query(`DROP POLICY IF EXISTS super_admin_bypass ON transaction;`);
    await queryRunner.query(`DROP POLICY IF EXISTS tenant_isolation ON transaction;`);
    await queryRunner.query(`ALTER TABLE transaction NO FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE transaction DISABLE ROW LEVEL SECURITY;`);

    const plainTables = ["customer_account", "ingestion_batch"];
    for (const table of plainTables) {
      await queryRunner.query(`DROP POLICY IF EXISTS super_admin_bypass ON ${table};`);
      await queryRunner.query(`DROP POLICY IF EXISTS tenant_isolation ON ${table};`);
      await queryRunner.query(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY;`);
      await queryRunner.query(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;`);
    }

    await queryRunner.query(`DROP TABLE IF EXISTS transaction_default;`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS create_transaction_partition(date);`);
    await queryRunner.query(`DROP TABLE IF EXISTS transaction CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS ingestion_batch;`);
    await queryRunner.query(`DROP TABLE IF EXISTS customer_account;`);

    await queryRunner.query(`DROP TYPE IF EXISTS ingestion_batch_status_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS account_status_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS account_type_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS transaction_source_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS transaction_channel_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS transaction_type_enum;`);
  }
}
