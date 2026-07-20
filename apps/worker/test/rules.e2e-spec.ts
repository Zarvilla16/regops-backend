import "reflect-metadata";
import * as crypto from "crypto";
import * as dotenv from "dotenv";
import * as path from "path";
import { DataSource } from "typeorm";
import { Queue, RedisClient } from "bullmq";
import {
  entities,
  AlertEntity,
  CustomerEntity,
  RiskFactorConfigEntity,
  RuleEntity,
  RuleEvaluationEntity,
  ScreeningCheckEntity,
  ScreeningProviderConfigEntity,
  TenantEntity,
  TransactionEntity,
} from "@regops/db";
import { DEFAULT_RISK_FACTOR_CONFIGS } from "@regops/risk-engine";
import { DEFAULT_RULE_CONFIGS } from "@regops/rules-engine";
import {
  AlertSeverity,
  AlertStatus,
  CustomerType,
  RULE_EVALUATION_QUEUE,
  RuleEvaluationResultStatus,
  RuleScenarioType,
  ScreeningCheckType,
  ScreeningProviderName,
  TenantStatus,
  TenantType,
  TransactionChannel,
  TransactionSource,
  TransactionType,
} from "@regops/shared";
import { evaluateTransaction } from "../src/rules/evaluate-rules.processor";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

/** Same host:port:password shape bullmq wants everywhere else in this app —
 * duplicated per-file rather than shared, same reasoning as every other
 * parseRedisUrl in this codebase (bundled-vs-standalone ioredis version
 * conflict). */
function parseRedisUrl(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    password: parsed.password || undefined,
    maxRetriesPerRequest: null as null,
  };
}

describe("Rules worker processor (e2e)", () => {
  let dataSource: DataSource;
  let bootstrapQueue: Queue;
  let redisClient: RedisClient;
  let tenantAId: string;
  let tenantBId: string;

  beforeAll(async () => {
    dataSource = new DataSource({ type: "postgres", url: process.env.DATABASE_ADMIN_URL, entities });
    await dataSource.initialize();

    // Borrows a BullMQ connection for the counterparty-screening cache
    // rather than opening a second ioredis client — same rationale as
    // evaluate-rules.processor.ts's own use of the real Worker's `.client`.
    const connection = parseRedisUrl(process.env.REDIS_URL ?? "redis://localhost:6379");
    bootstrapQueue = new Queue(RULE_EVALUATION_QUEUE, { connection });
    redisClient = await bootstrapQueue.client;

    tenantAId = (await seedTenant()).id;
    tenantBId = (await seedTenant()).id;
  });

  afterAll(async () => {
    await bootstrapQueue.close();
    await dataSource.destroy();
  });

  async function seedTenant(): Promise<TenantEntity> {
    const tenant = await dataSource.getRepository(TenantEntity).save(
      dataSource.getRepository(TenantEntity).create({
        name: `Rules Worker Test Tenant ${Date.now()}-${Math.random().toString(36).slice(2)}`,
        type: TenantType.MFB,
        status: TenantStatus.ACTIVE,
      }),
    );

    const riskConfigRepo = dataSource.getRepository(RiskFactorConfigEntity);
    for (const defaults of DEFAULT_RISK_FACTOR_CONFIGS) {
      await riskConfigRepo.save(
        riskConfigRepo.create({ tenantId: tenant.id, factorType: defaults.factorType, weight: defaults.weight, config: defaults.config, isActive: true }),
      );
    }

    const providerRepo = dataSource.getRepository(ScreeningProviderConfigEntity);
    for (const checkType of [ScreeningCheckType.SANCTIONS, ScreeningCheckType.PEP, ScreeningCheckType.ADVERSE_MEDIA]) {
      await providerRepo.save(
        providerRepo.create({
          tenantId: tenant.id,
          checkType,
          provider: ScreeningProviderName.MOCK,
          isPrimary: true,
          isFallback: false,
          credentialsRef: "env://MOCK_UNUSED",
          config: {},
          isActive: true,
        }),
      );
    }

    const ruleRepo = dataSource.getRepository(RuleEntity);
    for (const defaults of DEFAULT_RULE_CONFIGS) {
      await ruleRepo.save(
        ruleRepo.create({
          tenantId: tenant.id,
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

    return tenant;
  }

  async function findRule(tenantId: string, scenarioType: RuleScenarioType): Promise<RuleEntity> {
    return dataSource.getRepository(RuleEntity).findOneOrFail({ where: { tenantId, scenarioType } });
  }

  async function createCustomer(tenantId: string, overrides: Partial<CustomerEntity> = {}): Promise<CustomerEntity> {
    const repo = dataSource.getRepository(CustomerEntity);
    return repo.save(
      repo.create({
        tenantId,
        cbsCustomerId: `CUST-RULES-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        fullName: "Rules Worker Test Customer",
        customerType: CustomerType.INDIVIDUAL,
        country: "NG",
        kycTier: 2,
        onboardedAt: new Date("2024-01-01"),
        isPep: false,
        isSanctioned: false,
        ...overrides,
      }),
    );
  }

  async function createTransaction(
    tenantId: string,
    customerId: string,
    overrides: Partial<TransactionEntity> = {},
  ): Promise<TransactionEntity> {
    const repo = dataSource.getRepository(TransactionEntity);
    return repo.save(
      repo.create({
        id: crypto.randomUUID(),
        tenantId,
        cbsTransactionId: `TXN-RULES-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        customerId,
        accountNumber: "0123456789",
        amount: "0",
        currency: "NGN",
        type: TransactionType.CREDIT,
        channel: TransactionChannel.MOBILE,
        counterpartyAccount: null,
        counterpartyBank: null,
        counterpartyName: null,
        counterpartyCustomerId: null,
        narration: null,
        reference: null,
        balanceAfter: null,
        occurredAt: new Date(),
        source: TransactionSource.MANUAL,
        ingestionBatchId: null,
        ...overrides,
      }),
    );
  }

  // Section 5.2/6.x: the real per-transaction, per-rule evaluation loop —
  // moved here from apps/api's RuleEvaluationOrchestratorService (see
  // HANDOFF.md's Prompt 5 deviations for the history). These tests are the
  // direct continuation of apps/api/test/rules.e2e-spec.ts's former
  // "orchestrator: real per-scenario evaluation against Postgres" block,
  // now exercising the real production entry point (evaluateTransaction,
  // called by apps/worker's RULE_EVALUATION_QUEUE Worker) instead of a
  // dead-code copy — same "test follows the code" precedent as
  // processAsyncScreeningJob's own coverage in screening.e2e-spec.ts.
  describe("evaluateTransaction: real per-scenario evaluation against Postgres", () => {
    it("LARGE_CASH fires on a 6M cash CREDIT and returns the alert outcome", async () => {
      const customer = await createCustomer(tenantAId);
      const txn = await createTransaction(tenantAId, customer.id, { channel: TransactionChannel.CASH, amount: "6000000" });

      const result = await evaluateTransaction(dataSource, redisClient, tenantAId, txn.id);

      expect(result.alerts).toHaveLength(1);
      expect(result.alerts[0].scenarioType).toBe(RuleScenarioType.LARGE_CASH);
      expect(result.alerts[0].severity).toBe(AlertSeverity.MEDIUM);
      expect(result.alerts[0].wasInserted).toBe(true);
      expect(result.alerts[0].fireCount).toBe(1);

      const alert = await dataSource
        .getRepository(AlertEntity)
        .findOne({ where: { tenantId: tenantAId, customerId: customer.id, scenarioType: RuleScenarioType.LARGE_CASH } });
      expect(alert).not.toBeNull();
      expect(alert?.severity).toBe(AlertSeverity.MEDIUM);
      expect(alert?.status).toBe(AlertStatus.NEW);

      // All 5 active default rules should have produced a RuleEvaluation row.
      const evaluations = await dataSource.getRepository(RuleEvaluationEntity).find({ where: { transactionId: txn.id } });
      expect(evaluations).toHaveLength(5);
      expect(evaluations.filter((e) => e.result === RuleEvaluationResultStatus.FIRED)).toHaveLength(1);
    });

    it("re-evaluating the SAME transaction is idempotent: fire_count increments, no second Alert row", async () => {
      const customer = await createCustomer(tenantAId);
      const txn = await createTransaction(tenantAId, customer.id, { channel: TransactionChannel.CASH, amount: "7000000" });

      const first = await evaluateTransaction(dataSource, redisClient, tenantAId, txn.id);
      const second = await evaluateTransaction(dataSource, redisClient, tenantAId, txn.id);

      expect(first.alerts[0].wasInserted).toBe(true);
      expect(second.alerts[0].wasInserted).toBe(false);
      expect(second.alerts[0].fireCount).toBe(2);

      const alerts = await dataSource
        .getRepository(AlertEntity)
        .find({ where: { tenantId: tenantAId, customerId: customer.id, scenarioType: RuleScenarioType.LARGE_CASH } });
      const forThisTxn = alerts.filter((a) => a.triggeringTransactionId === txn.id);
      expect(forThisTxn).toHaveLength(1);
      expect(forThisTxn[0].fireCount).toBe(2);
    });

    it("disabling a rule stops it from being evaluated", async () => {
      const customer = await createCustomer(tenantAId);
      const rule = await findRule(tenantAId, RuleScenarioType.VELOCITY_SPIKE);
      await dataSource.getRepository(RuleEntity).update({ id: rule.id }, { isActive: false });

      const txn = await createTransaction(tenantAId, customer.id, { channel: TransactionChannel.CASH, amount: "1000" });
      await evaluateTransaction(dataSource, redisClient, tenantAId, txn.id);

      const evaluations = await dataSource.getRepository(RuleEvaluationEntity).find({ where: { transactionId: txn.id } });
      expect(evaluations.find((e) => e.ruleId === rule.id)).toBeUndefined();
      expect(evaluations).toHaveLength(4);

      await dataSource.getRepository(RuleEntity).update({ id: rule.id }, { isActive: true });
    });

    it("STRUCTURING fires on 3 cash deposits of 2M each within 24h", async () => {
      const customer = await createCustomer(tenantAId);
      const now = Date.now();
      await createTransaction(tenantAId, customer.id, {
        channel: TransactionChannel.CASH,
        amount: "2000000",
        occurredAt: new Date(now - 6 * 3_600_000),
      });
      await createTransaction(tenantAId, customer.id, {
        channel: TransactionChannel.CASH,
        amount: "2000000",
        occurredAt: new Date(now - 3 * 3_600_000),
      });
      const third = await createTransaction(tenantAId, customer.id, {
        channel: TransactionChannel.CASH,
        amount: "2000000",
        occurredAt: new Date(now),
      });

      await evaluateTransaction(dataSource, redisClient, tenantAId, third.id);

      const alert = await dataSource
        .getRepository(AlertEntity)
        .findOne({ where: { tenantId: tenantAId, customerId: customer.id, scenarioType: RuleScenarioType.STRUCTURING } });
      expect(alert).not.toBeNull();
      expect(alert?.severity).toBe(AlertSeverity.HIGH);
    });

    it("RAPID_INFLOW_OUTFLOW fires on inbound followed by a large outbound within 60 minutes", async () => {
      const customer = await createCustomer(tenantAId);
      const now = Date.now();
      await createTransaction(tenantAId, customer.id, {
        type: TransactionType.CREDIT,
        channel: TransactionChannel.TRANSFER,
        amount: "5000000",
        occurredAt: new Date(now - 35 * 60_000),
      });
      const outbound = await createTransaction(tenantAId, customer.id, {
        type: TransactionType.DEBIT,
        channel: TransactionChannel.TRANSFER,
        amount: "4500000",
        occurredAt: new Date(now),
      });

      await evaluateTransaction(dataSource, redisClient, tenantAId, outbound.id);

      const alert = await dataSource.getRepository(AlertEntity).findOne({
        where: { tenantId: tenantAId, customerId: customer.id, scenarioType: RuleScenarioType.RAPID_INFLOW_OUTFLOW },
      });
      expect(alert).not.toBeNull();
    });

    it("HIGH_RISK_COUNTERPARTY fires CRITICAL for an internal counterparty already flagged sanctioned", async () => {
      const customer = await createCustomer(tenantAId);
      const flaggedCounterparty = await createCustomer(tenantAId, { isSanctioned: true });
      const txn = await createTransaction(tenantAId, customer.id, {
        type: TransactionType.DEBIT,
        channel: TransactionChannel.TRANSFER,
        amount: "2500000",
        counterpartyCustomerId: flaggedCounterparty.id,
      });

      await evaluateTransaction(dataSource, redisClient, tenantAId, txn.id);

      const alert = await dataSource.getRepository(AlertEntity).findOne({
        where: { tenantId: tenantAId, customerId: customer.id, scenarioType: RuleScenarioType.HIGH_RISK_COUNTERPARTY },
      });
      expect(alert).not.toBeNull();
      expect(alert?.severity).toBe(AlertSeverity.CRITICAL);
    });

    it("HIGH_RISK_COUNTERPARTY fires CRITICAL for an external counterparty, and the second evaluation is served from cache (no new screening_check row)", async () => {
      const customer = await createCustomer(tenantAId);
      const counterpartyName = `SANCTIONED EXTERNAL PARTY ${crypto.randomUUID()}`;

      const first = await createTransaction(tenantAId, customer.id, {
        type: TransactionType.DEBIT,
        channel: TransactionChannel.TRANSFER,
        amount: "2500000",
        counterpartyBank: "058",
        counterpartyAccount: "0099887766",
        counterpartyName,
      });
      await evaluateTransaction(dataSource, redisClient, tenantAId, first.id);

      const alert1 = await dataSource.getRepository(AlertEntity).findOne({
        where: { tenantId: tenantAId, customerId: customer.id, scenarioType: RuleScenarioType.HIGH_RISK_COUNTERPARTY, triggeringTransactionId: first.id },
      });
      expect(alert1).not.toBeNull();
      expect(alert1?.severity).toBe(AlertSeverity.CRITICAL);

      const checksAfterFirst = await dataSource.getRepository(ScreeningCheckEntity).count({ where: { tenantId: tenantAId } });
      expect(checksAfterFirst).toBeGreaterThan(0);

      // Same counterparty (bank + account), a different day so it's a fresh dedup bucket/Alert —
      // isolates the cache-hit assertion from the dedup-increment behavior tested elsewhere.
      const second = await createTransaction(tenantAId, customer.id, {
        type: TransactionType.DEBIT,
        channel: TransactionChannel.TRANSFER,
        amount: "3000000",
        counterpartyBank: "058",
        counterpartyAccount: "0099887766",
        counterpartyName,
      });
      await evaluateTransaction(dataSource, redisClient, tenantAId, second.id);

      const checksAfterSecond = await dataSource.getRepository(ScreeningCheckEntity).count({ where: { tenantId: tenantAId } });
      expect(checksAfterSecond).toBe(checksAfterFirst);
    });

    it("VELOCITY_SPIKE fires when today's volume is 5x+ the rolling average for an established customer", async () => {
      const customer = await createCustomer(tenantAId, { onboardedAt: new Date(Date.now() - 200 * 86_400_000) });
      const now = Date.now();
      for (let daysAgo = 10; daysAgo >= 5; daysAgo--) {
        await createTransaction(tenantAId, customer.id, {
          channel: TransactionChannel.MOBILE,
          amount: "1000000",
          occurredAt: new Date(now - daysAgo * 86_400_000),
        });
      }
      const spike = await createTransaction(tenantAId, customer.id, {
        channel: TransactionChannel.MOBILE,
        amount: "7000000",
        occurredAt: new Date(now),
      });

      await evaluateTransaction(dataSource, redisClient, tenantAId, spike.id);

      const alert = await dataSource.getRepository(AlertEntity).findOne({
        where: { tenantId: tenantAId, customerId: customer.id, scenarioType: RuleScenarioType.VELOCITY_SPIKE },
      });
      expect(alert).not.toBeNull();
    });

    it("tenant isolation: a rule in tenant A does not fire on tenant B's transactions", async () => {
      const customerB = await createCustomer(tenantBId);
      const txn = await createTransaction(tenantBId, customerB.id, { channel: TransactionChannel.CASH, amount: "6000000" });

      await evaluateTransaction(dataSource, redisClient, tenantBId, txn.id);

      const alertUnderWrongTenant = await dataSource
        .getRepository(AlertEntity)
        .findOne({ where: { tenantId: tenantAId, triggeringTransactionId: txn.id } });
      expect(alertUnderWrongTenant).toBeNull();

      const alertUnderCorrectTenant = await dataSource
        .getRepository(AlertEntity)
        .findOne({ where: { tenantId: tenantBId, triggeringTransactionId: txn.id } });
      expect(alertUnderCorrectTenant).not.toBeNull();
    });

    it("a stale/replayed transaction.ingested event for a since-deleted transaction is skipped, not thrown", async () => {
      const result = await evaluateTransaction(dataSource, redisClient, tenantAId, crypto.randomUUID());
      expect(result.alerts).toHaveLength(0);
    });
  });
});
