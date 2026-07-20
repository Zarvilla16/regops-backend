import request from "supertest";
import * as crypto from "crypto";
import { DataSource, QueryRunner } from "typeorm";
import {
  AlertEntity,
  AuditLogEntity,
  CustomerEntity,
  RuleEntity,
  RuleEvaluationEntity,
  RuleReplayEntity,
  ScreeningCheckEntity,
  TransactionEntity,
} from "@regops/db";
import {
  AlertCloseCategory,
  AlertSeverity,
  AlertStatus,
  CustomerType,
  RuleEvaluationResultStatus,
  RuleReplayStatus,
  RuleScenarioType,
  TransactionChannel,
  TransactionSource,
  TransactionType,
  UserRole,
} from "@regops/shared";
import { RuleEvaluationOrchestratorService } from "../src/rules/evaluation/rule-evaluation-orchestrator.service";
import { RuleReplayService } from "../src/rules/replay/rule-replay.service";
import { AlertsService } from "../src/rules/alerts/alerts.service";
import {
  closeTestContext,
  createTenantFixture,
  createUserFixture,
  createTestContext,
  seedRiskFactorConfigsFixture,
  seedRuleCatalogFixture,
  seedScreeningProviderConfigsFixture,
  TestContext,
} from "./utils/test-app";

describe("Rules & Alerts module (e2e)", () => {
  let ctx: TestContext;
  let tenantAId: string;
  let tenantBId: string;
  let orchestrator: RuleEvaluationOrchestratorService;
  let replayService: RuleReplayService;
  let alertsService: AlertsService;
  let appDataSource: DataSource;

  beforeAll(async () => {
    ctx = await createTestContext();
    tenantAId = (await createTenantFixture(ctx.adminDataSource)).id;
    tenantBId = (await createTenantFixture(ctx.adminDataSource)).id;
    await seedRiskFactorConfigsFixture(ctx.adminDataSource, tenantAId);
    await seedRiskFactorConfigsFixture(ctx.adminDataSource, tenantBId);
    await seedScreeningProviderConfigsFixture(ctx.adminDataSource, tenantAId);
    await seedScreeningProviderConfigsFixture(ctx.adminDataSource, tenantBId);
    await seedRuleCatalogFixture(ctx.adminDataSource, tenantAId);
    await seedRuleCatalogFixture(ctx.adminDataSource, tenantBId);

    orchestrator = ctx.app.get(RuleEvaluationOrchestratorService);
    replayService = ctx.app.get(RuleReplayService);
    alertsService = ctx.app.get(AlertsService);
    appDataSource = ctx.app.get(DataSource);
  });

  afterAll(async () => {
    await closeTestContext(ctx);
  });

  const http = () => request(ctx.app.getHttpServer());

  async function loginAs(email: string, password: string): Promise<string> {
    const res = await http().post("/auth/login").send({ email, password }).expect(200);
    return res.body.data.accessToken;
  }

  async function tokenFor(tenantId: string, role: UserRole, emailSuffix: string): Promise<string> {
    const { user, password } = await createUserFixture(ctx.adminDataSource, tenantId, {
      email: `rules-${emailSuffix}@test.dev`,
      role,
    });
    return loginAs(user.email, password);
  }

  async function createCustomer(tenantId: string, overrides: Partial<CustomerEntity> = {}): Promise<CustomerEntity> {
    const repo = ctx.adminDataSource.getRepository(CustomerEntity);
    return repo.save(
      repo.create({
        tenantId,
        cbsCustomerId: `CUST-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        fullName: "Rules Test Customer",
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
    const repo = ctx.adminDataSource.getRepository(TransactionEntity);
    return repo.save(
      repo.create({
        id: crypto.randomUUID(),
        tenantId,
        cbsTransactionId: `TXN-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

  async function findRule(tenantId: string, scenarioType: RuleScenarioType): Promise<RuleEntity> {
    return ctx.adminDataSource.getRepository(RuleEntity).findOneOrFail({ where: { tenantId, scenarioType } });
  }

  // ---------------------------------------------------------------------
  describe("GET/PATCH /rules", () => {
    it("lists the 5 seeded rules for a tenant", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "list");
      const res = await http().get("/rules").set("Authorization", `Bearer ${token}`).expect(200);
      expect(res.body.data).toHaveLength(5);
      expect(res.body.data.map((r: { scenarioType: string }) => r.scenarioType).sort()).toEqual(
        Object.values(RuleScenarioType).sort(),
      );
    });

    it("VIEWER cannot list rules (403)", async () => {
      const token = await tokenFor(tenantAId, UserRole.VIEWER, "viewer-list");
      await http().get("/rules").set("Authorization", `Bearer ${token}`).expect(403);
    });

    it("PATCH isActive:false without a reason returns 400", async () => {
      const token = await tokenFor(tenantAId, UserRole.TENANT_ADMIN, "disable-no-reason");
      const rule = await findRule(tenantAId, RuleScenarioType.VELOCITY_SPIKE);
      await http().patch(`/rules/${rule.id}`).set("Authorization", `Bearer ${token}`).send({ isActive: false }).expect(400);
    });

    it("PATCH isActive:false with a reason succeeds and is audit-logged as rule.disable", async () => {
      const token = await tokenFor(tenantAId, UserRole.TENANT_ADMIN, "disable-ok");
      const rule = await findRule(tenantAId, RuleScenarioType.VELOCITY_SPIKE);
      const res = await http()
        .patch(`/rules/${rule.id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ isActive: false, reason: "Too many false positives during pilot" })
        .expect(200);
      expect(res.body.data.isActive).toBe(false);

      const audit = await ctx.adminDataSource
        .getRepository(AuditLogEntity)
        .findOne({ where: { tenantId: tenantAId, entityId: rule.id, action: "rule.disable" } });
      expect(audit).not.toBeNull();

      // Re-activate for later tests in this suite.
      await ctx.adminDataSource.getRepository(RuleEntity).update({ id: rule.id }, { isActive: true });
    });

    it("PATCH raising a threshold (loosening) without X-Confirm-Loosening returns 422", async () => {
      const token = await tokenFor(tenantAId, UserRole.TENANT_ADMIN, "loosen-no-confirm");
      const rule = await findRule(tenantAId, RuleScenarioType.LARGE_CASH);
      await http()
        .patch(`/rules/${rule.id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ config: { thresholdIndividual: 9_000_000 } })
        .expect(422);
    });

    it("PATCH raising a threshold with X-Confirm-Loosening: true succeeds", async () => {
      const token = await tokenFor(tenantAId, UserRole.TENANT_ADMIN, "loosen-confirm");
      const rule = await findRule(tenantAId, RuleScenarioType.LARGE_CASH);
      const res = await http()
        .patch(`/rules/${rule.id}`)
        .set("Authorization", `Bearer ${token}`)
        .set("X-Confirm-Loosening", "true")
        .send({ config: { thresholdIndividual: 9_000_000 } })
        .expect(200);
      expect(res.body.data.config.thresholdIndividual).toBe(9_000_000);

      // Restore for later tests.
      await http()
        .patch(`/rules/${rule.id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ config: { thresholdIndividual: 5_000_000 } })
        .expect(200);
    });

    it("PATCH lowering a threshold (tightening) never requires the confirm header", async () => {
      const token = await tokenFor(tenantAId, UserRole.TENANT_ADMIN, "tighten");
      const rule = await findRule(tenantAId, RuleScenarioType.LARGE_CASH);
      // 5,000,000 -> 4,000,000 is a decrease (tightening) — no header needed.
      await http()
        .patch(`/rules/${rule.id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ config: { thresholdIndividual: 4_000_000 } })
        .expect(200);
      // Restore to the default — this direction IS an increase (loosening), so it needs the header.
      await http()
        .patch(`/rules/${rule.id}`)
        .set("Authorization", `Bearer ${token}`)
        .set("X-Confirm-Loosening", "true")
        .send({ config: { thresholdIndividual: 5_000_000 } })
        .expect(200);
    });

    it("COMPLIANCE_OFFICER cannot PATCH a rule (403)", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "patch-forbidden");
      const rule = await findRule(tenantAId, RuleScenarioType.LARGE_CASH);
      await http().patch(`/rules/${rule.id}`).set("Authorization", `Bearer ${token}`).send({ isActive: false }).expect(403);
    });

    it("POST /rules/:id/test dry-runs without persisting an Alert or RuleEvaluation row", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "dry-run");
      const customer = await createCustomer(tenantAId);
      const txn = await createTransaction(tenantAId, customer.id, {
        channel: TransactionChannel.CASH,
        amount: "6000000",
      });
      const rule = await findRule(tenantAId, RuleScenarioType.LARGE_CASH);

      const alertsBefore = await ctx.adminDataSource.getRepository(AlertEntity).count({ where: { tenantId: tenantAId } });
      const evalsBefore = await ctx.adminDataSource.getRepository(RuleEvaluationEntity).count({ where: { tenantId: tenantAId } });

      const res = await http()
        .post(`/rules/${rule.id}/test`)
        .set("Authorization", `Bearer ${token}`)
        .send({ transactionId: txn.id })
        .expect(201);
      expect(res.body.data.fired).toBe(true);

      const alertsAfter = await ctx.adminDataSource.getRepository(AlertEntity).count({ where: { tenantId: tenantAId } });
      const evalsAfter = await ctx.adminDataSource.getRepository(RuleEvaluationEntity).count({ where: { tenantId: tenantAId } });
      expect(alertsAfter).toBe(alertsBefore);
      expect(evalsAfter).toBe(evalsBefore);
    });
  });

  // ---------------------------------------------------------------------
  describe("orchestrator: real per-scenario evaluation against Postgres", () => {
    it("LARGE_CASH fires on a 6M cash CREDIT", async () => {
      const customer = await createCustomer(tenantAId);
      const txn = await createTransaction(tenantAId, customer.id, { channel: TransactionChannel.CASH, amount: "6000000" });

      await orchestrator.evaluateTransaction(tenantAId, txn.id);

      const alert = await ctx.adminDataSource
        .getRepository(AlertEntity)
        .findOne({ where: { tenantId: tenantAId, customerId: customer.id, scenarioType: RuleScenarioType.LARGE_CASH } });
      expect(alert).not.toBeNull();
      expect(alert?.severity).toBe(AlertSeverity.MEDIUM);
      expect(alert?.status).toBe(AlertStatus.NEW);

      // All 5 active default rules should have produced a RuleEvaluation row.
      const evaluations = await ctx.adminDataSource.getRepository(RuleEvaluationEntity).find({ where: { transactionId: txn.id } });
      expect(evaluations).toHaveLength(5);
      expect(evaluations.filter((e) => e.result === RuleEvaluationResultStatus.FIRED)).toHaveLength(1);
    });

    it("re-evaluating the SAME transaction is idempotent: fire_count increments, no second Alert row", async () => {
      const customer = await createCustomer(tenantAId);
      const txn = await createTransaction(tenantAId, customer.id, { channel: TransactionChannel.CASH, amount: "7000000" });

      await orchestrator.evaluateTransaction(tenantAId, txn.id);
      await orchestrator.evaluateTransaction(tenantAId, txn.id);

      const alerts = await ctx.adminDataSource
        .getRepository(AlertEntity)
        .find({ where: { tenantId: tenantAId, customerId: customer.id, scenarioType: RuleScenarioType.LARGE_CASH } });
      const forThisTxn = alerts.filter((a) => a.triggeringTransactionId === txn.id);
      expect(forThisTxn).toHaveLength(1);
      expect(forThisTxn[0].fireCount).toBe(2);
    });

    it("disabling a rule stops it from being evaluated", async () => {
      const customer = await createCustomer(tenantAId);
      const rule = await findRule(tenantAId, RuleScenarioType.VELOCITY_SPIKE);
      await ctx.adminDataSource.getRepository(RuleEntity).update({ id: rule.id }, { isActive: false });

      const txn = await createTransaction(tenantAId, customer.id, { channel: TransactionChannel.CASH, amount: "1000" });
      await orchestrator.evaluateTransaction(tenantAId, txn.id);

      const evaluations = await ctx.adminDataSource.getRepository(RuleEvaluationEntity).find({ where: { transactionId: txn.id } });
      expect(evaluations.find((e) => e.ruleId === rule.id)).toBeUndefined();
      expect(evaluations).toHaveLength(4);

      await ctx.adminDataSource.getRepository(RuleEntity).update({ id: rule.id }, { isActive: true });
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

      await orchestrator.evaluateTransaction(tenantAId, third.id);

      const alert = await ctx.adminDataSource
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

      await orchestrator.evaluateTransaction(tenantAId, outbound.id);

      const alert = await ctx.adminDataSource.getRepository(AlertEntity).findOne({
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

      await orchestrator.evaluateTransaction(tenantAId, txn.id);

      const alert = await ctx.adminDataSource.getRepository(AlertEntity).findOne({
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
      await orchestrator.evaluateTransaction(tenantAId, first.id);

      const alert1 = await ctx.adminDataSource.getRepository(AlertEntity).findOne({
        where: { tenantId: tenantAId, customerId: customer.id, scenarioType: RuleScenarioType.HIGH_RISK_COUNTERPARTY, triggeringTransactionId: first.id },
      });
      expect(alert1).not.toBeNull();
      expect(alert1?.severity).toBe(AlertSeverity.CRITICAL);

      const checksAfterFirst = await ctx.adminDataSource
        .getRepository(ScreeningCheckEntity)
        .count({ where: { tenantId: tenantAId } });
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
      await orchestrator.evaluateTransaction(tenantAId, second.id);

      const checksAfterSecond = await ctx.adminDataSource
        .getRepository(ScreeningCheckEntity)
        .count({ where: { tenantId: tenantAId } });
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

      await orchestrator.evaluateTransaction(tenantAId, spike.id);

      const alert = await ctx.adminDataSource.getRepository(AlertEntity).findOne({
        where: { tenantId: tenantAId, customerId: customer.id, scenarioType: RuleScenarioType.VELOCITY_SPIKE },
      });
      expect(alert).not.toBeNull();
    });

    it("tenant isolation: a rule in tenant A does not fire on tenant B's transactions", async () => {
      const customerB = await createCustomer(tenantBId);
      const txn = await createTransaction(tenantBId, customerB.id, { channel: TransactionChannel.CASH, amount: "6000000" });

      await orchestrator.evaluateTransaction(tenantBId, txn.id);

      const alertUnderWrongTenant = await ctx.adminDataSource
        .getRepository(AlertEntity)
        .findOne({ where: { tenantId: tenantAId, triggeringTransactionId: txn.id } });
      expect(alertUnderWrongTenant).toBeNull();

      const alertUnderCorrectTenant = await ctx.adminDataSource
        .getRepository(AlertEntity)
        .findOne({ where: { tenantId: tenantBId, triggeringTransactionId: txn.id } });
      expect(alertUnderCorrectTenant).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  describe("alert dedup race safety", () => {
    async function withQr<T>(tenantId: string, fn: (qr: QueryRunner) => Promise<T>): Promise<T> {
      const qr = appDataSource.createQueryRunner();
      await qr.connect();
      await qr.startTransaction();
      try {
        await qr.query(`SELECT set_config('app.current_tenant_id', $1, true), set_config('app.bypass_rls', 'false', true)`, [tenantId]);
        const result = await fn(qr);
        await qr.commitTransaction();
        return result;
      } catch (err) {
        if (qr.isTransactionActive) await qr.rollbackTransaction();
        throw err;
      } finally {
        await qr.release();
      }
    }

    it("two concurrent fires with the same dedup_key produce exactly one Alert with fire_count = 2", async () => {
      const customer = await createCustomer(tenantAId);
      const rule = await findRule(tenantAId, RuleScenarioType.LARGE_CASH);
      const dedupKey = `race-test:${crypto.randomUUID()}`;

      const fire = () =>
        withQr(tenantAId, (qr) =>
          alertsService.createOrIncrement(qr, {
            tenantId: tenantAId,
            rule,
            customerId: customer.id,
            triggeringTransactionId: null,
            severity: AlertSeverity.MEDIUM,
            title: "Race test alert",
            evidence: { relatedTransactionIds: [crypto.randomUUID()] },
            dedupKey,
            firedAt: new Date(),
          }),
        );

      await Promise.all([fire(), fire()]);

      const matching = await ctx.adminDataSource.getRepository(AlertEntity).find({ where: { tenantId: tenantAId, dedupKey } });
      expect(matching).toHaveLength(1);
      expect(matching[0].fireCount).toBe(2);
      expect(matching[0].evidence.relatedTransactionIds).toHaveLength(2);
    });

    it("a closed alert's dedup_key can recur as a new Alert row", async () => {
      const customer = await createCustomer(tenantAId);
      const rule = await findRule(tenantAId, RuleScenarioType.LARGE_CASH);
      const dedupKey = `recur-test:${crypto.randomUUID()}`;

      const first = await withQr(tenantAId, (qr) =>
        alertsService.createOrIncrement(qr, {
          tenantId: tenantAId,
          rule,
          customerId: customer.id,
          triggeringTransactionId: null,
          severity: AlertSeverity.MEDIUM,
          title: "Recurrence test",
          evidence: {},
          dedupKey,
          firedAt: new Date(),
        }),
      );
      expect(first.wasInserted).toBe(true);

      await withQr(tenantAId, (qr) =>
        qr.manager.getRepository(AlertEntity).update({ id: first.alert.id }, { status: AlertStatus.CLOSED, closedAt: new Date() }),
      );

      const second = await withQr(tenantAId, (qr) =>
        alertsService.createOrIncrement(qr, {
          tenantId: tenantAId,
          rule,
          customerId: customer.id,
          triggeringTransactionId: null,
          severity: AlertSeverity.MEDIUM,
          title: "Recurrence test",
          evidence: {},
          dedupKey,
          firedAt: new Date(),
        }),
      );
      expect(second.wasInserted).toBe(true);
      expect(second.alert.id).not.toBe(first.alert.id);
    });
  });

  // ---------------------------------------------------------------------
  describe("alerts endpoints", () => {
    it("lists, assigns, and closes an alert", async () => {
      const customer = await createCustomer(tenantAId);
      const txn = await createTransaction(tenantAId, customer.id, { channel: TransactionChannel.CASH, amount: "6500000" });
      await orchestrator.evaluateTransaction(tenantAId, txn.id);

      const adminToken = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "alerts-flow");
      const listRes = await http()
        .get("/alerts")
        .query({ status: "NEW", scenario_type: "LARGE_CASH" })
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);
      const alertDto = listRes.body.data.data.find((a: { triggeringTransactionId: string }) => a.triggeringTransactionId === txn.id);
      expect(alertDto).toBeDefined();

      const { user: investigator } = await createUserFixture(ctx.adminDataSource, tenantAId, {
        email: "investigator-assignee@test.dev",
        role: UserRole.INVESTIGATOR,
      });

      const assignRes = await http()
        .post(`/alerts/${alertDto.id}/assign`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ assignedTo: investigator.id })
        .expect(201);
      expect(assignRes.body.data.status).toBe("ASSIGNED");
      expect(assignRes.body.data.assignedTo).toBe(investigator.id);

      const relatedRes = await http()
        .get(`/alerts/${alertDto.id}/related-transactions`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);
      expect(relatedRes.body.data.map((t: { id: string }) => t.id)).toContain(txn.id);

      const closeRes = await http()
        .post(`/alerts/${alertDto.id}/close`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ category: AlertCloseCategory.RESOLVED, reason: "Confirmed legitimate large withdrawal" })
        .expect(201);
      expect(closeRes.body.data.status).toBe("CLOSED");
      expect(closeRes.body.data.closeCategory).toBe("RESOLVED");

      const auditClose = await ctx.adminDataSource
        .getRepository(AuditLogEntity)
        .findOne({ where: { tenantId: tenantAId, entityId: alertDto.id, action: "alert.close" } });
      expect(auditClose).not.toBeNull();
    });

    it("tenant isolation: alert listing never returns another tenant's alerts", async () => {
      const tokenA = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "iso-a");
      const customerB = await createCustomer(tenantBId);
      const txnB = await createTransaction(tenantBId, customerB.id, { channel: TransactionChannel.CASH, amount: "9000000" });
      await orchestrator.evaluateTransaction(tenantBId, txnB.id);

      const res = await http().get("/alerts").set("Authorization", `Bearer ${tokenA}`).expect(200);
      expect(res.body.data.data.find((a: { triggeringTransactionId: string }) => a.triggeringTransactionId === txnB.id)).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------
  describe("rule replay", () => {
    it("dry-run produces no Alert or RuleEvaluation rows but reports a fired count", async () => {
      const customer = await createCustomer(tenantAId);
      const from = new Date(Date.now() - 3_600_000);
      await createTransaction(tenantAId, customer.id, { channel: TransactionChannel.CASH, amount: "6000000", occurredAt: new Date() });
      const to = new Date(Date.now() + 3_600_000);

      const rule = await findRule(tenantAId, RuleScenarioType.LARGE_CASH);
      const alertsBefore = await ctx.adminDataSource.getRepository(AlertEntity).count({ where: { tenantId: tenantAId } });

      const replayId = await replayService.replay({ tenantId: tenantAId, ruleId: rule.id, from, to, dryRun: true });

      const replay = await ctx.adminDataSource.getRepository(RuleReplayEntity).findOneOrFail({ where: { id: replayId } });
      expect(replay.status).toBe(RuleReplayStatus.COMPLETED);
      expect(replay.dryRun).toBe(true);
      expect(replay.firedCount).toBeGreaterThanOrEqual(1);
      expect(replay.reportKey).not.toBeNull();

      const alertsAfter = await ctx.adminDataSource.getRepository(AlertEntity).count({ where: { tenantId: tenantAId } });
      expect(alertsAfter).toBe(alertsBefore);
    });

    it("a live replay creates alerts; re-running increments fire_count on the same dedup key", async () => {
      const customer = await createCustomer(tenantAId);
      const from = new Date(Date.now() - 3_600_000);
      const txn = await createTransaction(tenantAId, customer.id, {
        channel: TransactionChannel.CASH,
        amount: "6200000",
        occurredAt: new Date(),
      });
      const to = new Date(Date.now() + 3_600_000);
      const rule = await findRule(tenantAId, RuleScenarioType.LARGE_CASH);

      await replayService.replay({ tenantId: tenantAId, ruleId: rule.id, from, to, dryRun: false });
      const alert = await ctx.adminDataSource
        .getRepository(AlertEntity)
        .findOneOrFail({ where: { tenantId: tenantAId, triggeringTransactionId: txn.id } });
      expect(alert.fireCount).toBe(1);

      await replayService.replay({ tenantId: tenantAId, ruleId: rule.id, from, to, dryRun: false });
      const alertAfterRerun = await ctx.adminDataSource.getRepository(AlertEntity).findOneOrFail({ where: { id: alert.id } });
      expect(alertAfterRerun.fireCount).toBe(2);

      const evaluations = await ctx.adminDataSource.getRepository(RuleEvaluationEntity).find({ where: { transactionId: txn.id } });
      expect(evaluations.length).toBeGreaterThanOrEqual(2);
    });
  });
});
