import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Enables Postgres row-level security on every tenant-scoped table.
 *
 * This migration must run as a role with BYPASSRLS (regops_admin) so it can
 * create the policies; the running API connects as regops_app, which has
 * NO BYPASSRLS, so these policies are actually enforced for every query it
 * issues. TenantContextMiddleware sets `app.current_tenant_id` (and, for
 * SUPER_ADMIN with an explicit override, `app.bypass_rls`) per-request via
 * set_config(..., true) on the transaction-scoped connection.
 */
export class RowLevelSecurity1700000001000 implements MigrationInterface {
  name = "RowLevelSecurity1700000001000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tables = ["user", "audit_log", "idempotency_key"];

    for (const table of tables) {
      const quoted = table === "user" ? `"user"` : table;
      await queryRunner.query(`ALTER TABLE ${quoted} ENABLE ROW LEVEL SECURITY;`);
      await queryRunner.query(`ALTER TABLE ${quoted} FORCE ROW LEVEL SECURITY;`);

      await queryRunner.query(`
        CREATE POLICY tenant_isolation ON ${quoted}
          USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
      `);

      await queryRunner.query(`
        CREATE POLICY super_admin_bypass ON ${quoted}
          USING (current_setting('app.bypass_rls', true) = 'true');
      `);
    }

    // audit_log is INSERT-only at the database role level: application code
    // (and anyone connecting as regops_app) can never UPDATE or DELETE rows.
    await queryRunner.query(`REVOKE UPDATE, DELETE ON audit_log FROM regops_app;`);
    await queryRunner.query(`GRANT SELECT, INSERT ON audit_log TO regops_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`GRANT UPDATE, DELETE ON audit_log TO regops_app;`);

    const tables = ["user", "audit_log", "idempotency_key"];
    for (const table of tables) {
      const quoted = table === "user" ? `"user"` : table;
      await queryRunner.query(`DROP POLICY IF EXISTS super_admin_bypass ON ${quoted};`);
      await queryRunner.query(`DROP POLICY IF EXISTS tenant_isolation ON ${quoted};`);
      await queryRunner.query(`ALTER TABLE ${quoted} NO FORCE ROW LEVEL SECURITY;`);
      await queryRunner.query(`ALTER TABLE ${quoted} DISABLE ROW LEVEL SECURITY;`);
    }
  }
}
