import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Backend Prompt 6: case, case_alert, case_assignment_event, case_note,
 * case_evidence, case_approval_event, report. All plain (low volume — case
 * volume is an order of magnitude below alert volume), same RLS
 * enable/force + policy pattern as every migration since Prompt 1.
 *
 * customer_id/assigned_to/created_by/submitted_by/approved_by/closed_by/
 * alert_id/user_id/uploaded_by/actor/generated_by are all FK-by-convention
 * only (no REFERENCES) — same choice made throughout Prompts 2-5.
 */
export class Cases1700000060000 implements MigrationInterface {
  name = "Cases1700000060000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE case_status_enum AS ENUM ('OPEN', 'UNDER_INVESTIGATION', 'PENDING_APPROVAL', 'SAR_FILED', 'CLOSED');
    `);
    await queryRunner.query(`
      CREATE TYPE case_priority_enum AS ENUM ('LOW', 'MEDIUM', 'HIGH');
    `);
    await queryRunner.query(`
      CREATE TYPE case_approval_outcome_enum AS ENUM ('APPROVED', 'REJECTED');
    `);
    await queryRunner.query(`
      CREATE TYPE report_type_enum AS ENUM ('SAR');
    `);
    await queryRunner.query(`
      CREATE TYPE report_status_enum AS ENUM ('DRAFT');
    `);

    // --- case ------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "case" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        case_number varchar(50) NOT NULL,
        customer_id uuid NOT NULL,
        status case_status_enum NOT NULL DEFAULT 'OPEN',
        priority case_priority_enum NOT NULL,
        assigned_to uuid,
        created_by uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        submitted_by uuid,
        submitted_at timestamptz,
        approved_by uuid,
        approved_at timestamptz,
        escalation_rationale text,
        closed_at timestamptz,
        closed_by uuid,
        closure_reason text
      );
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_case_tenant_case_number ON "case" (tenant_id, case_number);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_case_tenant_status ON "case" (tenant_id, status);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_case_tenant_customer ON "case" (tenant_id, customer_id);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_case_tenant_assigned_to ON "case" (tenant_id, assigned_to);
    `);

    // --- case_alert ---------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE case_alert (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        case_id uuid NOT NULL,
        alert_id uuid NOT NULL,
        linked_at timestamptz NOT NULL,
        linked_by uuid NOT NULL
      );
    `);
    // Section 2.3: an alert belongs to at most one case, ever — enforced at the DB
    // level via a unique index on alert_id ALONE, not (case_id, alert_id).
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_case_alert_alert_id ON case_alert (alert_id);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_case_alert_tenant_case ON case_alert (tenant_id, case_id);
    `);

    // --- case_assignment_event ------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE case_assignment_event (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        case_id uuid NOT NULL,
        assigned_to uuid,
        assigned_by uuid NOT NULL,
        at timestamptz NOT NULL
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_case_assignment_event_tenant_case ON case_assignment_event (tenant_id, case_id);
    `);

    // --- case_note ------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE case_note (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        case_id uuid NOT NULL,
        user_id uuid NOT NULL,
        content text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_case_note_tenant_case ON case_note (tenant_id, case_id);
    `);

    // --- case_evidence ------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE case_evidence (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        case_id uuid NOT NULL,
        file_name text NOT NULL,
        file_key text NOT NULL,
        file_type varchar(255) NOT NULL,
        file_size_bytes integer NOT NULL,
        uploaded_by uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_case_evidence_tenant_case ON case_evidence (tenant_id, case_id);
    `);

    // --- case_approval_event --------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE case_approval_event (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        case_id uuid NOT NULL,
        outcome case_approval_outcome_enum NOT NULL,
        actor uuid NOT NULL,
        reason text,
        at timestamptz NOT NULL
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_case_approval_event_tenant_case ON case_approval_event (tenant_id, case_id);
    `);

    // --- report (minimal seed — Backend Prompt 7 extends this) ----------------------
    await queryRunner.query(`
      CREATE TABLE report (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        case_id uuid NOT NULL,
        customer_id uuid NOT NULL,
        report_type report_type_enum NOT NULL,
        status report_status_enum NOT NULL DEFAULT 'DRAFT',
        generated_at timestamptz NOT NULL,
        generated_by uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_report_case_id ON report (case_id);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_report_tenant ON report (tenant_id);
    `);

    // --- RLS ------------------------------------------------------------------------
    const tables = ["case", "case_alert", "case_assignment_event", "case_note", "case_evidence", "case_approval_event", "report"];
    for (const table of tables) {
      const quoted = table === "case" ? `"case"` : table;
      await queryRunner.query(`ALTER TABLE ${quoted} ENABLE ROW LEVEL SECURITY;`);
      await queryRunner.query(`ALTER TABLE ${quoted} FORCE ROW LEVEL SECURITY;`);
      await queryRunner.query(`
        CREATE POLICY tenant_isolation ON ${quoted}
          USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
      `);
      await queryRunner.query(`
        CREATE POLICY super_admin_bypass ON ${quoted}
          USING (current_setting('app.bypass_rls', true) = 'true');
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const tables = ["report", "case_approval_event", "case_evidence", "case_note", "case_assignment_event", "case_alert", "case"];
    for (const table of tables) {
      const quoted = table === "case" ? `"case"` : table;
      await queryRunner.query(`DROP POLICY IF EXISTS super_admin_bypass ON ${quoted};`);
      await queryRunner.query(`DROP POLICY IF EXISTS tenant_isolation ON ${quoted};`);
      await queryRunner.query(`ALTER TABLE ${quoted} NO FORCE ROW LEVEL SECURITY;`);
      await queryRunner.query(`ALTER TABLE ${quoted} DISABLE ROW LEVEL SECURITY;`);
    }

    await queryRunner.query(`DROP TABLE IF EXISTS report;`);
    await queryRunner.query(`DROP TABLE IF EXISTS case_approval_event;`);
    await queryRunner.query(`DROP TABLE IF EXISTS case_evidence;`);
    await queryRunner.query(`DROP TABLE IF EXISTS case_note;`);
    await queryRunner.query(`DROP TABLE IF EXISTS case_assignment_event;`);
    await queryRunner.query(`DROP TABLE IF EXISTS case_alert;`);
    await queryRunner.query(`DROP TABLE IF EXISTS "case";`);

    await queryRunner.query(`DROP TYPE IF EXISTS report_status_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS report_type_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS case_approval_outcome_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS case_priority_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS case_status_enum;`);
  }
}
