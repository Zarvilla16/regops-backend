import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { DataSource } from "typeorm";
import { RuleEntity, TenantEntity } from "@regops/db";
import { DEFAULT_RULE_CONFIGS } from "@regops/rules-engine";
import { AppModule } from "../../app.module";
import { RulesService } from "../rules.service";

// No manual dotenv.config() here — AppModule's ConfigModule.forRoot() already
// loads .env declaratively as part of bootstrapping, same as
// apps/api/src/main.ts and rule-replay.cli.ts.

/**
 * One-off backfill (no nest-commander — this codebase has never depended on
 * it, same reasoning as rule-replay.cli.ts's own docblock): tenants created
 * before Backend Prompt 5 shipped have zero `Rule` rows, since rule seeding
 * (`RulesService.seedDefaultsForTenant`) only ever runs inside
 * `TenantsService.create()` — there is no retroactive seeding for tenants
 * that already existed. `pnpm cli:rule-backfill [-- --dry-run]`.
 *
 * Reuses `RulesService.seedDefaultsForTenant` verbatim — the exact same
 * method `TenantsService.create()` calls for brand-new tenants — rather than
 * re-deriving `DEFAULT_RULE_CONFIGS` here. That method is already idempotent
 * per (tenant, scenario_type), so calling it is always safe; this script's
 * own pre-check (comparing each tenant's existing `scenario_type`s against
 * `DEFAULT_RULE_CONFIGS`) exists only to decide what to report as
 * seeded/skipped, and to give `--dry-run` something to inspect without
 * writing anything — not to duplicate the idempotency guarantee, which
 * `seedDefaultsForTenant` already provides on its own. Deliberately checked
 * per scenario_type, not just `ruleCount === 0`: a coarser
 * "already has any rules" check would incorrectly skip a tenant that's
 * missing only some of the 5 defaults (e.g. a partially-seeded row from a
 * future manual edit) and leave it stuck that way forever.
 */
async function main(): Promise<void> {
  const dryRun = process.argv.slice(2).includes("--dry-run");

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn"] });
  try {
    const dataSource = app.get(DataSource);
    const rulesService = app.get(RulesService);
    const expectedScenarioTypes = DEFAULT_RULE_CONFIGS.map((d) => d.scenarioType);

    const tenants = await dataSource.getRepository(TenantEntity).find({ order: { createdAt: "ASC" } });
    console.log(`Rule backfill${dryRun ? " (dry run)" : ""}: scanning ${tenants.length} tenant(s)...\n`);

    let seeded = 0;
    let skipped = 0;
    let failed = 0;

    for (const tenant of tenants) {
      const queryRunner = dataSource.createQueryRunner();
      await queryRunner.connect();
      try {
        await queryRunner.startTransaction();
        // Same rationale as TenantsService.create(): this script runs outside
        // any single tenant's own request context, so app.bypass_rls must be
        // explicitly true to read/write this tenant's rows at all.
        await queryRunner.query(
          `SELECT set_config('app.current_tenant_id', $1, true), set_config('app.bypass_rls', 'true', true)`,
          [tenant.id],
        );

        const existingRules = await queryRunner.manager.getRepository(RuleEntity).find({ where: { tenantId: tenant.id } });
        const existingScenarioTypes = new Set(existingRules.map((r) => r.scenarioType));
        const missing = expectedScenarioTypes.filter((st) => !existingScenarioTypes.has(st));

        if (missing.length === 0) {
          await queryRunner.rollbackTransaction(); // read-only path, nothing to commit
          skipped += 1;
          console.log(`  [SKIPPED] ${tenant.name} (${tenant.id}) — already has all ${expectedScenarioTypes.length} default rules`);
          continue;
        }

        if (dryRun) {
          await queryRunner.rollbackTransaction();
          seeded += 1;
          console.log(
            `  [WOULD SEED] ${tenant.name} (${tenant.id}) — missing ${missing.length}/${expectedScenarioTypes.length}: ${missing.join(", ")}`,
          );
          continue;
        }

        await rulesService.seedDefaultsForTenant(queryRunner, tenant.id);
        await queryRunner.commitTransaction();
        seeded += 1;
        console.log(
          `  [SEEDED]  ${tenant.name} (${tenant.id}) — added ${missing.length}/${expectedScenarioTypes.length} missing rule(s): ${missing.join(", ")} (had ${existingRules.length} already)`,
        );
      } catch (err) {
        if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
        failed += 1;
        console.error(`  [FAILED]  ${tenant.name} (${tenant.id}) — ${(err as Error).message}`);
      } finally {
        await queryRunner.release();
      }
    }

    console.log(
      `\nSummary: ${seeded} ${dryRun ? "would be seeded" : "seeded"}, ${skipped} skipped (already complete), ${failed} failed — ${tenants.length} tenant(s) total.`,
    );
    if (failed > 0) process.exitCode = 1;
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error("Rule backfill failed:", err);
  process.exit(1);
});
