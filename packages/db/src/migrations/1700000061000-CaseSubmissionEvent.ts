import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Forward-only fix, same pattern as 1700000002000-FixTenantIsolationEmptyStringCast.ts
 * (a same-branch correction added as its own migration rather than editing the
 * already-applied 1700000060000-Cases.ts).
 *
 * CaseTimelineService's "submitted" event was originally derived from the live
 * case.submitted_by/submitted_at columns — but reject() correctly nulls both of
 * those (so a resubmission starts clean), which meant the timeline silently lost
 * the historical record that a submission had ever happened once a case was
 * rejected. case_submission_event is a durable, insert-only record of every
 * submit() call, exactly mirroring case_approval_event's own shape/rationale for
 * existing — a case submitted, rejected, and resubmitted now has two rows here,
 * and the timeline renders both, independent of what the live columns currently
 * hold.
 */
export class CaseSubmissionEvent1700000061000 implements MigrationInterface {
  name = "CaseSubmissionEvent1700000061000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE case_submission_event (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        case_id uuid NOT NULL,
        actor uuid NOT NULL,
        rationale text NOT NULL,
        at timestamptz NOT NULL
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_case_submission_event_tenant_case ON case_submission_event (tenant_id, case_id);
    `);

    await queryRunner.query(`ALTER TABLE case_submission_event ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE case_submission_event FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON case_submission_event
        USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
    `);
    await queryRunner.query(`
      CREATE POLICY super_admin_bypass ON case_submission_event
        USING (current_setting('app.bypass_rls', true) = 'true');
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP POLICY IF EXISTS super_admin_bypass ON case_submission_event;`);
    await queryRunner.query(`DROP POLICY IF EXISTS tenant_isolation ON case_submission_event;`);
    await queryRunner.query(`ALTER TABLE case_submission_event NO FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE case_submission_event DISABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`DROP TABLE IF EXISTS case_submission_event;`);
  }
}
