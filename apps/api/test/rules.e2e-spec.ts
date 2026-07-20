import request from "supertest";
import * as crypto from "crypto";
import { DataSource, QueryRunner } from "typeorm";
import { Queue } from "bullmq";
import {
  AlertEntity,
  AuditLogEntity,
  CustomerEntity,
  RuleEntity,
  RuleEvaluationEntity,
  RuleReplayEntity,
  TransactionEntity,
} from "@regops/db";
import {
  AlertCloseCategory,
  AlertSeverity,
  AlertStatus,
  CustomerType,
  RULE_EVALUATION_QUEUE,
  RuleReplayStatus,
  RuleScenarioType,
  TransactionChannel,
  TransactionSource,
  TransactionType,
  UserRole,
} from "@regops/shared";
import { RuleReplayService } from "../src/rules/replay/rule-replay.service";
import { AlertsService } from "../src/rules/alerts/alerts.service";
import { RuleEvaluationQueueService } from "../src/rules/queue/rule-evaluation-queue.service";
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

/** Same host:port:password shape bullmq wants — duplicated per-file, same
 * reasoning as every other parseRedisUrl in this codebase (bundled-vs-
 * standalone ioredis version conflict); exact mirror of
 * screening.e2e-spec.ts's own inspection-queue helper. */
function parseRedisUrl(url: string) {
  const parsed = new URL(url);
  return { host: parsed.hostname, port: Number(parsed.port || 6379), password: parsed.password || undefined, maxRetriesPerRequest: null as null };
}

describe("Rules & Alerts module (e2e)", () => {
  let ctx: TestContext;
  let tenantAId: string;
  let tenantBId: string;
  let replayService: RuleReplayService;
  let alertsService: AlertsService;
  let ruleEvaluationQueueService: RuleEvaluationQueueService;
  let appDataSource: DataSource;
  let inspectionQueue: Queue;

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

    replayService = ctx.app.get(RuleReplayService);
    alertsService = ctx.app.get(AlertsService);
    ruleEvaluationQueueService = ctx.app.get(RuleEvaluationQueueService);
    appDataSource = ctx.app.get(DataSource);
    // Independent inspection client — a real, second connection to the same
    // queue, standing in for what a second apps/api replica's own
    // RuleEvaluationQueueService instance would see, same convention as
    // screening.e2e-spec.ts's asyncQueue.
    inspectionQueue = new Queue(RULE_EVALUATION_QUEUE, { connection: parseRedisUrl(process.env.REDIS_URL!) });
  });

  afterAll(async () => {
    await inspectionQueue.close();
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

  /** Used by tests that need a real Alert row without going through a full
   * rule evaluation — that real, end-to-end evaluation loop now runs in
   * apps/worker (evaluateTransaction) and is covered there; see
   * apps/worker/test/rules.e2e-spec.ts. */
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

  async function seedAlert(
    tenantId: string,
    customerId: string,
    transactionId: string,
    scenarioType: RuleScenarioType,
  ): Promise<AlertEntity> {
    const rule = await findRule(tenantId, scenarioType);
    const outcome = await withQr(tenantId, (qr) =>
      alertsService.createOrIncrement(qr, {
        tenantId,
        rule,
        customerId,
        triggeringTransactionId: transactionId,
        severity: AlertSeverity.MEDIUM,
        title: "Test-seeded alert",
        evidence: { relatedTransactionIds: [transactionId] },
        dedupKey: `${scenarioType}:${customerId}:${transactionId}`,
        firedAt: new Date(),
      }),
    );
    return outcome.alert;
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
  describe("RuleEvaluationQueueService: idempotent enqueue across apps/api replicas", () => {
    it("enqueuing the same transactionId twice creates exactly one BullMQ job, not two", async () => {
      // Simulates the real multi-instance scenario this guards against:
      // transaction.ingested is itself raised by TransactionIngestionQueueService's
      // own QueueEvents bridge, which every live apps/api replica runs a copy of —
      // Redis pub/sub fans that bridge's "completed" notification out to every
      // subscriber, so N replicas each independently call
      // TransactionListener.onTransactionIngested -> RuleEvaluationQueueService.enqueue
      // for the SAME transaction. Two enqueue() calls with the same transactionId
      // here stand in for two such replicas (this test's ctx.app is one "replica";
      // a second call to the same DI-resolved service is behaviorally identical to
      // a second replica's own instance calling .add() against the same Redis —
      // BullMQ's dedup is enforced server-side in Redis, not client-side).
      const transactionId = crypto.randomUUID();

      const jobId1 = await ruleEvaluationQueueService.enqueue({ tenantId: tenantAId, transactionId });
      const jobId2 = await ruleEvaluationQueueService.enqueue({ tenantId: tenantAId, transactionId });

      // Before the fix, RuleEvaluationQueueService.enqueue() called queue.add()
      // with no explicit jobId, so BullMQ auto-generates a fresh unique id on
      // every call — this assertion alone would fail against the old code
      // (jobId1 !== jobId2).
      expect(jobId1).toBe(transactionId);
      expect(jobId2).toBe(transactionId);

      // The real proof, not just an id-equality coincidence: enumerate every
      // job in the queue (across every state) whose data.transactionId matches
      // and confirm there is exactly one, not two independent job entries.
      const allJobs = await inspectionQueue.getJobs(["waiting", "active", "completed", "failed", "delayed", "paused"]);
      const matching = allJobs.filter((j) => j.data.transactionId === transactionId);
      expect(matching).toHaveLength(1);
      expect(matching[0].data).toEqual({ tenantId: tenantAId, transactionId });
    });

    it("a different transactionId still gets its own independent job (dedup is per-transaction, not global)", async () => {
      const transactionIdA = crypto.randomUUID();
      const transactionIdB = crypto.randomUUID();

      const jobIdA = await ruleEvaluationQueueService.enqueue({ tenantId: tenantAId, transactionId: transactionIdA });
      const jobIdB = await ruleEvaluationQueueService.enqueue({ tenantId: tenantAId, transactionId: transactionIdB });

      expect(jobIdA).not.toBe(jobIdB);
      const jobA = await inspectionQueue.getJob(transactionIdA);
      const jobB = await inspectionQueue.getJob(transactionIdB);
      expect(jobA).toBeDefined();
      expect(jobB).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------
  describe("alert dedup race safety", () => {
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
      await seedAlert(tenantAId, customer.id, txn.id, RuleScenarioType.LARGE_CASH);

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
      await seedAlert(tenantBId, customerB.id, txnB.id, RuleScenarioType.LARGE_CASH);

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
