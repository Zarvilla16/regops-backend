import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Backend Prompt 5: rule, alert, rule_evaluation (partitioned), rule_replay.
 *
 * rule_evaluation is high-volume (one row per active rule per evaluated
 * transaction — 5 rows/transaction at v1's fixed 5-scenario catalog), so
 * it's RANGE-partitioned by evaluated_at, monthly — identical mechanism to
 * TransactionEntity's occurred_at partitioning (Transactions1700000040000):
 * same idempotent create_*_partition() helper pattern, same DEFAULT
 * partition for out-of-range rows, same "ENABLE/FORCE ROW LEVEL SECURITY
 * does not propagate from parent to partition" trap re-applied per partition.
 *
 * rule, alert, rule_replay are plain (low volume — five Rule rows per
 * tenant, Alert volume orders of magnitude below Transaction volume).
 *
 * rule_id / customer_id / triggering_transaction_id / alert_id references
 * are FK-by-convention only (no REFERENCES) — same choice made throughout
 * Prompts 2-4: RLS enforces tenant isolation, not referential integrity.
 */
export class RulesAndAlerts1700000050000 implements MigrationInterface {
  name = "RulesAndAlerts1700000050000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Counterparty screening (Section 6.4) reuses ScreeningService.runCheckInline
    // with a new trigger value — owned by Screening1700000020000's
    // screening_trigger_enum. Same "safe inside this migration's transaction,
    // down() cannot cleanly undo" reasoning as Transactions1700000040000's
    // own ALTER TYPE ADD VALUE statements.
    await queryRunner.query(`ALTER TYPE screening_trigger_enum ADD VALUE IF NOT EXISTS 'TRANSACTION_MONITORING';`);

    await queryRunner.query(`
      CREATE TYPE rule_scenario_type_enum AS ENUM (
        'LARGE_CASH', 'STRUCTURING', 'RAPID_INFLOW_OUTFLOW', 'HIGH_RISK_COUNTERPARTY', 'VELOCITY_SPIKE'
      );
    `);
    await queryRunner.query(`
      CREATE TYPE alert_severity_enum AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
    `);
    await queryRunner.query(`
      CREATE TYPE rule_action_enum AS ENUM ('FLAG', 'REVIEW', 'BLOCK');
    `);
    await queryRunner.query(`
      CREATE TYPE alert_status_enum AS ENUM ('NEW', 'ASSIGNED', 'UNDER_REVIEW', 'CLOSED', 'ESCALATED');
    `);
    await queryRunner.query(`
      CREATE TYPE alert_close_category_enum AS ENUM ('FALSE_POSITIVE', 'RESOLVED');
    `);
    await queryRunner.query(`
      CREATE TYPE rule_evaluation_result_enum AS ENUM ('FIRED', 'NOT_FIRED', 'ERROR');
    `);
    await queryRunner.query(`
      CREATE TYPE rule_replay_status_enum AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');
    `);

    // --- rule -----------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE rule (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        name varchar(255) NOT NULL,
        scenario_type rule_scenario_type_enum NOT NULL,
        description text,
        config jsonb NOT NULL,
        severity alert_severity_enum NOT NULL,
        action rule_action_enum NOT NULL DEFAULT 'FLAG',
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz
      );
    `);
    // Section 3.1: exactly one Rule per (tenant, scenario_type) in v1.
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_rule_tenant_scenario_type ON rule (tenant_id, scenario_type);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_rule_tenant_is_active ON rule (tenant_id, is_active);
    `);

    // --- alert ------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE alert (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        rule_id uuid NOT NULL,
        customer_id uuid NOT NULL,
        triggering_transaction_id uuid,
        scenario_type rule_scenario_type_enum NOT NULL,
        severity alert_severity_enum NOT NULL,
        status alert_status_enum NOT NULL DEFAULT 'NEW',

        title varchar(500) NOT NULL,
        evidence jsonb NOT NULL,

        dedup_key varchar(255) NOT NULL,
        fire_count integer NOT NULL DEFAULT 1,
        first_fired_at timestamptz NOT NULL,
        last_fired_at timestamptz NOT NULL,

        assigned_to uuid,
        closed_at timestamptz,
        closed_by uuid,
        close_category alert_close_category_enum,
        closure_reason text,

        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    // Section 3.2: partial unique index — a CLOSED alert's dedup_key can
    // recur later; the same pattern firing again after closure is a signal,
    // not noise to suppress. This is also what makes AlertsService's
    // ON CONFLICT (tenant_id, dedup_key) WHERE status != 'CLOSED' UPSERT work.
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_alert_tenant_dedup_key_open
        ON alert (tenant_id, dedup_key) WHERE status != 'CLOSED';
    `);
    await queryRunner.query(`
      CREATE INDEX idx_alert_tenant_status_severity_first_fired
        ON alert (tenant_id, status, severity, first_fired_at DESC);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_alert_tenant_customer_first_fired
        ON alert (tenant_id, customer_id, first_fired_at DESC);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_alert_tenant_rule_first_fired
        ON alert (tenant_id, rule_id, first_fired_at DESC);
    `);

    // --- rule_evaluation (partitioned) ------------------------------------------
    await queryRunner.query(`
      CREATE TABLE rule_evaluation (
        id uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        rule_id uuid NOT NULL,
        transaction_id uuid,
        evaluated_at timestamptz NOT NULL,
        duration_ms integer NOT NULL,
        result rule_evaluation_result_enum NOT NULL,
        alert_id uuid,
        error_message text,

        PRIMARY KEY (id, evaluated_at)
      ) PARTITION BY RANGE (evaluated_at);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_rule_evaluation_tenant_rule_evaluated_at
        ON rule_evaluation (tenant_id, rule_id, evaluated_at DESC);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_rule_evaluation_tenant_transaction_id
        ON rule_evaluation (tenant_id, transaction_id) WHERE transaction_id IS NOT NULL;
    `);

    // Same idempotent-partition-creation-function pattern as
    // create_transaction_partition (Transactions1700000040000) — see that
    // migration's docblock for the ENABLE/FORCE ROW LEVEL SECURITY trap this
    // function re-applies per partition.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION create_rule_evaluation_partition(for_date date)
      RETURNS void AS $$
      DECLARE
        month_start date := date_trunc('month', for_date)::date;
        month_end date := (date_trunc('month', for_date) + interval '1 month')::date;
        partition_name text := 'rule_evaluation_' || to_char(month_start, 'YYYY_MM');
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = partition_name) THEN
          EXECUTE format(
            'CREATE TABLE %I PARTITION OF rule_evaluation FOR VALUES FROM (%L) TO (%L)',
            partition_name, month_start, month_end
          );
          EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', partition_name);
          EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', partition_name);
        END IF;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await queryRunner.query(`
      DO $$
      DECLARE
        i int;
      BEGIN
        FOR i IN 0..5 LOOP
          PERFORM create_rule_evaluation_partition((now() + (i * interval '1 month'))::date);
        END LOOP;
      END;
      $$;
    `);

    await queryRunner.query(`
      CREATE TABLE rule_evaluation_default PARTITION OF rule_evaluation DEFAULT;
    `);
    await queryRunner.query(`ALTER TABLE rule_evaluation_default ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE rule_evaluation_default FORCE ROW LEVEL SECURITY;`);

    // --- rule_replay --------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE rule_replay (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        rule_id uuid,
        from_date date NOT NULL,
        to_date date NOT NULL,
        dry_run boolean NOT NULL DEFAULT false,
        status rule_replay_status_enum NOT NULL DEFAULT 'QUEUED',
        total_transactions integer NOT NULL DEFAULT 0,
        processed_transactions integer NOT NULL DEFAULT 0,
        fired_count integer NOT NULL DEFAULT 0,
        report_key text,
        started_at timestamptz,
        completed_at timestamptz,
        error_message text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_rule_replay_tenant_created_at ON rule_replay (tenant_id, created_at DESC);
    `);

    // --- RLS ------------------------------------------------------------------
    const plainTables = ["rule", "alert", "rule_replay"];
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

    await queryRunner.query(`ALTER TABLE rule_evaluation ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE rule_evaluation FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON rule_evaluation
        USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
    `);
    await queryRunner.query(`
      CREATE POLICY super_admin_bypass ON rule_evaluation
        USING (current_setting('app.bypass_rls', true) = 'true');
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // screening_trigger_enum's TRANSACTION_MONITORING value is NOT removed —
    // Postgres has no "drop enum value" operation (see the comment in up()).
    await queryRunner.query(`DROP POLICY IF EXISTS super_admin_bypass ON rule_evaluation;`);
    await queryRunner.query(`DROP POLICY IF EXISTS tenant_isolation ON rule_evaluation;`);
    await queryRunner.query(`ALTER TABLE rule_evaluation NO FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE rule_evaluation DISABLE ROW LEVEL SECURITY;`);

    const plainTables = ["rule", "alert", "rule_replay"];
    for (const table of plainTables) {
      await queryRunner.query(`DROP POLICY IF EXISTS super_admin_bypass ON ${table};`);
      await queryRunner.query(`DROP POLICY IF EXISTS tenant_isolation ON ${table};`);
      await queryRunner.query(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY;`);
      await queryRunner.query(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;`);
    }

    await queryRunner.query(`DROP TABLE IF EXISTS rule_evaluation_default;`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS create_rule_evaluation_partition(date);`);
    await queryRunner.query(`DROP TABLE IF EXISTS rule_evaluation CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS rule_replay;`);
    await queryRunner.query(`DROP TABLE IF EXISTS alert;`);
    await queryRunner.query(`DROP TABLE IF EXISTS rule;`);

    await queryRunner.query(`DROP TYPE IF EXISTS rule_replay_status_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS rule_evaluation_result_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS alert_close_category_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS alert_status_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS rule_action_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS alert_severity_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS rule_scenario_type_enum;`);
  }
}
