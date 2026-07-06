import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Fixes a cast error in the tenant_isolation policy created by
 * RowLevelSecurity1700000001000.
 *
 * `app.current_tenant_id` is set via `set_config(..., true)` (transaction-
 * local) so it's automatically discarded when the request's transaction
 * ends. For a connection where this custom GUC has never been referenced at
 * all, `current_setting('app.current_tenant_id', true)` correctly returns
 * NULL. But Postgres only tracks "no value yet" for custom (non-built-in)
 * GUCs the first time; once a transaction has SET LOCAL'd it even once, the
 * value that connection reverts to after commit/rollback is an empty string
 * (''), not NULL — and this persists for the lifetime of that physical
 * connection. Since regops_app's connections are pooled and reused across
 * unrelated requests (e.g. AuthService.login's bypass-only path never sets
 * current_tenant_id at all), any request reusing such a connection would hit
 * `''::uuid`, which raises "invalid input syntax for type uuid" and 500s
 * instead of correctly excluding all rows.
 */
export class FixTenantIsolationEmptyStringCast1700000002000 implements MigrationInterface {
  name = "FixTenantIsolationEmptyStringCast1700000002000";

  private readonly tables = ["user", "audit_log", "idempotency_key"];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of this.tables) {
      const quoted = table === "user" ? `"user"` : table;
      await queryRunner.query(`DROP POLICY tenant_isolation ON ${quoted};`);
      await queryRunner.query(`
        CREATE POLICY tenant_isolation ON ${quoted}
          USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of this.tables) {
      const quoted = table === "user" ? `"user"` : table;
      await queryRunner.query(`DROP POLICY tenant_isolation ON ${quoted};`);
      await queryRunner.query(`
        CREATE POLICY tenant_isolation ON ${quoted}
          USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
      `);
    }
  }
}
