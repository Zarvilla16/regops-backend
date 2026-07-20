import "reflect-metadata";
import * as dotenv from "dotenv";
import * as path from "path";

// Integration tests run against a real Postgres/Redis (docker-compose up),
// with migrations already applied (pnpm db:migrate). This loads the same
// .env the api app itself uses.
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as argon2 from "argon2";
import { DataSource } from "typeorm";
import {
  AlertEntity,
  AuditLogEntity,
  CustomerAccountEntity,
  CustomerEntity,
  IngestionBatchEntity,
  PepDetailsEntity,
  RefreshTokenEntity,
  RiskFactorConfigEntity,
  RiskScoreHistoryEntity,
  RuleEntity,
  RuleEvaluationEntity,
  RuleReplayEntity,
  ScreeningCheckEntity,
  ScreeningMatchEntity,
  ScreeningProviderConfigEntity,
  TenantEntity,
  TransactionEntity,
  UserEntity,
} from "@regops/db";
import { ScreeningCheckType, ScreeningProviderName, TenantStatus, TenantType, UserRole, UserStatus } from "@regops/shared";
import { DEFAULT_RISK_FACTOR_CONFIGS } from "@regops/risk-engine";
import { DEFAULT_RULE_CONFIGS } from "@regops/rules-engine";
import { AppModule } from "../../src/app.module";
import { configureApp } from "../../src/main";

export const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
};

export const DEFAULT_TEST_PASSWORD = "Password123!456789";

export interface TestContext {
  app: INestApplication;
  adminDataSource: DataSource;
}

/**
 * adminDataSource connects as regops_admin (BYPASSRLS) so tests can freely
 * arrange/assert fixtures across tenants regardless of RLS — the app under
 * test (`app`) itself still connects as regops_app, so HTTP requests made
 * against it are fully subject to RLS like production traffic.
 */
export async function createTestContext(): Promise<TestContext> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  // rawBody: true — see main.ts's bootstrap() docblock; webhook e2e tests need
  // req.rawBody for HMAC verification just like the real server. Single-arg
  // form matters: createNestApplication(undefined, opts) silently drops opts
  // (TestingModule treats a non-HttpServer first arg as *the options*,
  // discarding the real second argument entirely).
  const app = moduleRef.createNestApplication({ rawBody: true });
  configureApp(app);
  await app.init();

  const adminDataSource = new DataSource({
    type: "postgres",
    url: process.env.DATABASE_ADMIN_URL,
    entities: [
      TenantEntity,
      UserEntity,
      RefreshTokenEntity,
      AuditLogEntity,
      CustomerEntity,
      RiskScoreHistoryEntity,
      RiskFactorConfigEntity,
      ScreeningProviderConfigEntity,
      ScreeningCheckEntity,
      ScreeningMatchEntity,
      PepDetailsEntity,
      TransactionEntity,
      CustomerAccountEntity,
      IngestionBatchEntity,
      RuleEntity,
      AlertEntity,
      RuleEvaluationEntity,
      RuleReplayEntity,
    ],
  });
  await adminDataSource.initialize();

  return { app, adminDataSource };
}

export async function closeTestContext(ctx: TestContext): Promise<void> {
  await ctx.adminDataSource.destroy();
  await ctx.app.close();
}

export async function createTenantFixture(
  ds: DataSource,
  overrides: Partial<TenantEntity> = {},
): Promise<TenantEntity> {
  const repo = ds.getRepository(TenantEntity);
  return repo.save(
    repo.create({
      name: overrides.name ?? `Test Tenant ${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type: overrides.type ?? TenantType.MFB,
      status: overrides.status ?? TenantStatus.ACTIVE,
      ...overrides,
    }),
  );
}

/** AuthService.login() matches by email alone across ALL tenants, with no
 * tenant scoping (HANDOFF.md Prompt 1 deviation #4) — and this project's dev
 * Postgres persists across e2e runs rather than resetting per invocation. A
 * literal, un-suffixed email reused by a second run collides with a prior
 * run's still-present fixture user in a different (stale) tenant, making the
 * match ambiguous and 401ing every subsequent login using that email — this
 * cascades to unrelated tests in the same run (see HANDOFF.md bug #16).
 * Appending a random nonce here, unconditionally, closes this for every
 * caller at once: the literal passed in stays readable in failure traces,
 * but the actual persisted/returned `user.email` is always unique. Safe as
 * long as callers log in with the *returned* `user.email`, not by
 * reconstructing the literal they passed in — true everywhere in this suite. */
function uniquifyEmail(email: string): string {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const at = email.indexOf("@");
  return at === -1 ? `${email}-${nonce}` : `${email.slice(0, at)}-${nonce}${email.slice(at)}`;
}

export async function createUserFixture(
  ds: DataSource,
  tenantId: string,
  overrides: Partial<UserEntity> & { password?: string } = {},
): Promise<{ user: UserEntity; password: string }> {
  const repo = ds.getRepository(UserEntity);
  const password = overrides.password ?? DEFAULT_TEST_PASSWORD;
  const passwordHash = await argon2.hash(password, ARGON2_OPTIONS);

  const email = overrides.email
    ? uniquifyEmail(overrides.email)
    : `user-${Date.now()}-${Math.random().toString(36).slice(2)}@test.dev`;

  const user = await repo.save(
    repo.create({
      tenantId,
      email,
      passwordHash,
      fullName: overrides.fullName ?? "Test User",
      role: overrides.role ?? UserRole.VIEWER,
      status: overrides.status ?? UserStatus.ACTIVE,
      mfaEnabled: overrides.mfaEnabled ?? false,
      mfaSecret: overrides.mfaSecret ?? null,
      failedLoginCount: overrides.failedLoginCount ?? 0,
      lockedUntil: overrides.lockedUntil ?? null,
    }),
  );

  return { user, password };
}

/**
 * createTenantFixture is a raw insert (bypassing TenantsService.create()),
 * so it doesn't get the default RiskFactorConfig rows real tenant creation
 * seeds — call this too for any test that creates customers, or every
 * factor silently no-ops (no config row => skipped) and every score comes
 * back 0/LOW regardless of input.
 */
export async function seedRiskFactorConfigsFixture(ds: DataSource, tenantId: string): Promise<void> {
  const repo = ds.getRepository(RiskFactorConfigEntity);
  for (const defaults of DEFAULT_RISK_FACTOR_CONFIGS) {
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

/**
 * Same reasoning as seedRiskFactorConfigsFixture above — createTenantFixture
 * bypasses TenantsService.create(), so it doesn't get the default
 * ScreeningProviderConfig rows real tenant creation seeds. Defaults to
 * MockProvider as primary for every check type (no fallback) — deterministic
 * and network-free, matching Section 7.3's "CI never calls Smile ID or
 * Prembly". Pass `overrides` to configure a fallback for retry/fallback
 * tests.
 */
export async function seedScreeningProviderConfigsFixture(
  ds: DataSource,
  tenantId: string,
  overrides?: Partial<Record<ScreeningCheckType, { fallback?: ScreeningProviderName }>>,
): Promise<void> {
  const repo = ds.getRepository(ScreeningProviderConfigEntity);
  const checkTypes = [ScreeningCheckType.SANCTIONS, ScreeningCheckType.PEP, ScreeningCheckType.ADVERSE_MEDIA];

  for (const checkType of checkTypes) {
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

    const fallbackProvider = overrides?.[checkType]?.fallback;
    if (fallbackProvider) {
      await repo.save(
        repo.create({
          tenantId,
          checkType,
          provider: fallbackProvider,
          isPrimary: false,
          isFallback: true,
          credentialsRef: `env://${fallbackProvider}_UNUSED`,
          config: {},
          isActive: true,
        }),
      );
    }
  }
}

/**
 * Same reasoning as seedRiskFactorConfigsFixture — createTenantFixture
 * bypasses TenantsService.create(), so it doesn't get the default Rule rows
 * real tenant creation seeds (RulesService.seedDefaultsForTenant). Pass
 * `overrides` keyed by scenario_type to tweak a specific scenario's config
 * for a test (e.g. a lower LARGE_CASH threshold so a small fixture amount
 * still crosses it).
 */
export async function seedRuleCatalogFixture(
  ds: DataSource,
  tenantId: string,
  overrides?: Partial<Record<string, Record<string, unknown>>>,
): Promise<RuleEntity[]> {
  const repo = ds.getRepository(RuleEntity);
  const saved: RuleEntity[] = [];
  for (const defaults of DEFAULT_RULE_CONFIGS) {
    const rule = await repo.save(
      repo.create({
        tenantId,
        name: defaults.name,
        scenarioType: defaults.scenarioType,
        description: defaults.description,
        config: { ...defaults.config, ...overrides?.[defaults.scenarioType] },
        severity: defaults.severity,
        action: defaults.action,
        isActive: true,
      }),
    );
    saved.push(rule);
  }
  return saved;
}
