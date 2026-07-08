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
  AuditLogEntity,
  CustomerEntity,
  RefreshTokenEntity,
  RiskFactorConfigEntity,
  RiskScoreHistoryEntity,
  TenantEntity,
  UserEntity,
} from "@regops/db";
import { TenantStatus, TenantType, UserRole, UserStatus } from "@regops/shared";
import { DEFAULT_RISK_FACTOR_CONFIGS } from "@regops/risk-engine";
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
  const app = moduleRef.createNestApplication();
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

export async function createUserFixture(
  ds: DataSource,
  tenantId: string,
  overrides: Partial<UserEntity> & { password?: string } = {},
): Promise<{ user: UserEntity; password: string }> {
  const repo = ds.getRepository(UserEntity);
  const password = overrides.password ?? DEFAULT_TEST_PASSWORD;
  const passwordHash = await argon2.hash(password, ARGON2_OPTIONS);

  const user = await repo.save(
    repo.create({
      tenantId,
      email:
        overrides.email ?? `user-${Date.now()}-${Math.random().toString(36).slice(2)}@test.dev`,
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
