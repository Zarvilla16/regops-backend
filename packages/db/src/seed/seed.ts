import "reflect-metadata";
import * as dotenv from "dotenv";
import * as argon2 from "argon2";
import { AppDataSource } from "../data-source";
import { TenantEntity } from "../entities/tenant.entity";
import { UserEntity } from "../entities/user.entity";
import { RiskFactorConfigEntity } from "../entities/risk-factor-config.entity";
import { ScreeningProviderConfigEntity } from "../entities/screening-provider-config.entity";
import { RuleEntity } from "../entities/rule.entity";
import { ScreeningCheckType, ScreeningProviderName, TenantStatus, TenantType, UserRole, UserStatus } from "@regops/shared";
import { DEFAULT_RISK_FACTOR_CONFIGS } from "@regops/risk-engine";
import { DEFAULT_RULE_CONFIGS } from "@regops/rules-engine";

dotenv.config();

const SUPER_ADMIN_EMAIL = process.env.SEED_SUPER_ADMIN_EMAIL ?? "superadmin@regops.dev";
const SUPER_ADMIN_PASSWORD = process.env.SEED_SUPER_ADMIN_PASSWORD ?? "SuperAdmin!2026";

const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
};

async function hash(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

/**
 * Idempotent — safe to re-run against a tenant that's already been seeded.
 * Section 11's Definition of Done: "MockProvider as primary in non-prod
 * env; SmileId primary + Prembly fallback in prod env." Seeding always runs
 * with regops_admin (BYPASSRLS) via docker-compose/local dev, which is
 * never a production environment, so this seeds the non-prod (MockProvider)
 * defaults unconditionally — a real prod deployment provisions tenants
 * through the API (ScreeningProviderConfigService.seedDefaultsForTenant),
 * not this CLI script.
 */
async function seedScreeningProviderConfigs(tenantId: string): Promise<void> {
  const repo = AppDataSource.getRepository(ScreeningProviderConfigEntity);
  const checkTypes = [ScreeningCheckType.SANCTIONS, ScreeningCheckType.PEP, ScreeningCheckType.ADVERSE_MEDIA];

  for (const checkType of checkTypes) {
    const existing = await repo.findOne({ where: { tenantId, checkType, isPrimary: true } });
    if (existing) continue;
    await repo.save(
      repo.create({
        tenantId,
        checkType,
        provider: ScreeningProviderName.MOCK,
        isPrimary: true,
        isFallback: false,
        credentialsRef: "env://MOCK_PROVIDER_UNUSED",
        config: {},
        isActive: true,
      }),
    );
  }
}

/** Idempotent — safe to re-run against a tenant that's already been seeded. */
async function seedRiskFactorConfigs(tenantId: string): Promise<void> {
  const repo = AppDataSource.getRepository(RiskFactorConfigEntity);
  for (const defaults of DEFAULT_RISK_FACTOR_CONFIGS) {
    const existing = await repo.findOne({ where: { tenantId, factorType: defaults.factorType } });
    if (existing) continue;
    await repo.save(
      repo.create({
        tenantId,
        factorType: defaults.factorType,
        weight: defaults.weight,
        config: defaults.config,
        isActive: true,
      }),
    );
  }
}

/** Idempotent — safe to re-run against a tenant that's already been seeded. */
async function seedRuleCatalog(tenantId: string): Promise<void> {
  const repo = AppDataSource.getRepository(RuleEntity);
  for (const defaults of DEFAULT_RULE_CONFIGS) {
    const existing = await repo.findOne({ where: { tenantId, scenarioType: defaults.scenarioType } });
    if (existing) continue;
    await repo.save(
      repo.create({
        tenantId,
        name: defaults.name,
        scenarioType: defaults.scenarioType,
        description: defaults.description,
        config: defaults.config,
        severity: defaults.severity,
        action: defaults.action,
        isActive: true,
      }),
    );
  }
}

/**
 * Seeding runs as regops_admin (BYPASSRLS), so no tenant session var needs to
 * be set here — RLS only constrains the regops_app role used by the API.
 */
async function seed(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("The dev seed has a default password; use `pnpm db:bootstrap` to create the first Super Admin in production.");
  }
  await AppDataSource.initialize();

  const tenantRepo = AppDataSource.getRepository(TenantEntity);
  const userRepo = AppDataSource.getRepository(UserEntity);

  // --- Platform-level super admin (tenant_id still required by schema, so a
  // dedicated internal "platform" tenant houses it). ---
  let platformTenant = await tenantRepo.findOne({ where: { name: "RegOps Platform" } });
  if (!platformTenant) {
    platformTenant = await tenantRepo.save(
      tenantRepo.create({
        name: "RegOps Platform",
        type: TenantType.FINTECH,
        status: TenantStatus.ACTIVE,
        config: { internal: true },
      }),
    );
    console.log(`Created platform tenant: ${platformTenant.id}`);
  }
  await seedRiskFactorConfigs(platformTenant.id);
  await seedScreeningProviderConfigs(platformTenant.id);
  await seedRuleCatalog(platformTenant.id);

  let superAdmin = await userRepo.findOne({
    where: { tenantId: platformTenant.id, email: SUPER_ADMIN_EMAIL },
  });
  if (!superAdmin) {
    superAdmin = await userRepo.save(
      userRepo.create({
        tenantId: platformTenant.id,
        email: SUPER_ADMIN_EMAIL,
        passwordHash: await hash(SUPER_ADMIN_PASSWORD),
        fullName: "RegOps Super Admin",
        role: UserRole.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
      }),
    );
    console.log(`Created SUPER_ADMIN: ${SUPER_ADMIN_EMAIL}`);
  }

  console.log("\nSeed complete. Local development login:");
  console.table([{ role: "SUPER_ADMIN", email: SUPER_ADMIN_EMAIL, password: SUPER_ADMIN_PASSWORD }]);

  await AppDataSource.destroy();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
