import "reflect-metadata";
import * as dotenv from "dotenv";
import { DataSource, DataSourceOptions } from "typeorm";
import { TenantEntity } from "./entities/tenant.entity";
import { UserEntity } from "./entities/user.entity";
import { RefreshTokenEntity } from "./entities/refresh-token.entity";
import { AuditLogEntity } from "./entities/audit-log.entity";
import { IdempotencyKeyEntity } from "./entities/idempotency-key.entity";
import { CustomerEntity } from "./entities/customer.entity";
import { RiskScoreHistoryEntity } from "./entities/risk-score-history.entity";
import { RiskFactorConfigEntity } from "./entities/risk-factor-config.entity";
import { ScreeningProviderConfigEntity } from "./entities/screening-provider-config.entity";
import { ScreeningCheckEntity } from "./entities/screening-check.entity";
import { ScreeningMatchEntity } from "./entities/screening-match.entity";
import { InternalBlacklistEntity } from "./entities/internal-blacklist.entity";
import { PepDetailsEntity } from "./entities/pep-details.entity";
import { TransactionEntity } from "./entities/transaction.entity";
import { CustomerAccountEntity } from "./entities/customer-account.entity";
import { IngestionBatchEntity } from "./entities/ingestion-batch.entity";

dotenv.config();

export const entities = [
  TenantEntity,
  UserEntity,
  RefreshTokenEntity,
  AuditLogEntity,
  IdempotencyKeyEntity,
  CustomerEntity,
  RiskScoreHistoryEntity,
  RiskFactorConfigEntity,
  ScreeningProviderConfigEntity,
  ScreeningCheckEntity,
  ScreeningMatchEntity,
  InternalBlacklistEntity,
  PepDetailsEntity,
  TransactionEntity,
  CustomerAccountEntity,
  IngestionBatchEntity,
];

/**
 * Connection string used for running migrations/seeds. Must point at the
 * regops_admin role (BYPASSRLS) — the running API instead connects with
 * DATABASE_URL (regops_app, no bypass) so RLS is actually enforced.
 */
const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  "postgres://regops_admin:regops_admin_password@localhost:5433/regops";

export const dataSourceOptions: DataSourceOptions = {
  type: "postgres",
  url: adminUrl,
  entities,
  migrations: [__dirname + "/migrations/*.{ts,js}"],
  migrationsTableName: "typeorm_migrations",
  synchronize: false,
  logging: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
};

export const AppDataSource = new DataSource(dataSourceOptions);
