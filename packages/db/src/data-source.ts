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
import { RuleEntity } from "./entities/rule.entity";
import { AlertEntity } from "./entities/alert.entity";
import { RuleEvaluationEntity } from "./entities/rule-evaluation.entity";
import { RuleReplayEntity } from "./entities/rule-replay.entity";
import { CaseEntity } from "./entities/case.entity";
import { CaseAlertEntity } from "./entities/case-alert.entity";
import { CaseAssignmentEventEntity } from "./entities/case-assignment-event.entity";
import { CaseNoteEntity } from "./entities/case-note.entity";
import { CaseEvidenceEntity } from "./entities/case-evidence.entity";
import { CaseApprovalEventEntity } from "./entities/case-approval-event.entity";
import { CaseSubmissionEventEntity } from "./entities/case-submission-event.entity";
import { ReportEntity } from "./entities/report.entity";

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
  RuleEntity,
  AlertEntity,
  RuleEvaluationEntity,
  RuleReplayEntity,
  CaseEntity,
  CaseAlertEntity,
  CaseAssignmentEventEntity,
  CaseNoteEntity,
  CaseEvidenceEntity,
  CaseApprovalEventEntity,
  CaseSubmissionEventEntity,
  ReportEntity,
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
