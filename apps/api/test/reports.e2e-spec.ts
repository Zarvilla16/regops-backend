import request from "supertest";
import * as crypto from "crypto";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { DataSource, QueryRunner } from "typeorm";
import { AlertEntity, AuditLogEntity, CustomerEntity, ReportEntity, RuleEntity, TransactionEntity } from "@regops/db";
import {
  AlertSeverity,
  AlertStatus,
  CustomerType,
  ReportStatus,
  ReportType,
  RiskLevel,
  RuleScenarioType,
  TransactionChannel,
  TransactionSource,
  TransactionType,
  UserRole,
} from "@regops/shared";
import { AlertsService } from "../src/rules/alerts/alerts.service";
import {
  closeTestContext,
  createTenantFixture,
  createTestContext,
  createUserFixture,
  seedRiskFactorConfigsFixture,
  seedRuleCatalogFixture,
  seedScreeningProviderConfigsFixture,
  TestContext,
} from "./utils/test-app";

describe("Reports module (e2e)", () => {
  let ctx: TestContext;
  let tenantAId: string;
  let tenantBId: string;
  let appDataSource: DataSource;
  let alertsService: AlertsService;
  let events: EventEmitter2;

  // Compliance officers in tenant A. coA creates/approves cases (=> generatedBy of every SAR draft), coB submits them.
  let coA: { id: string; token: string; name: string };
  let coB: { id: string; token: string };
  let coC: { id: string; token: string };
  const roleTokens = {} as Record<UserRole, string>;
  let tenantBOfficerToken: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    tenantAId = (await createTenantFixture(ctx.adminDataSource, { name: "Reports Test MFB", cbnLicenseNumber: "MFB-LIC-7777" })).id;
    tenantBId = (await createTenantFixture(ctx.adminDataSource)).id;
    for (const t of [tenantAId, tenantBId]) {
      await seedRiskFactorConfigsFixture(ctx.adminDataSource, t);
      await seedScreeningProviderConfigsFixture(ctx.adminDataSource, t);
      await seedRuleCatalogFixture(ctx.adminDataSource, t);
    }
    appDataSource = ctx.app.get(DataSource);
    alertsService = ctx.app.get(AlertsService);
    events = ctx.app.get(EventEmitter2);

    const mk = async (tenantId: string, role: UserRole, suffix: string, fullName = "Test User") => {
      const { user, password } = await createUserFixture(ctx.adminDataSource, tenantId, { email: `reports-${suffix}@test.dev`, role, fullName });
      const res = await http().post("/auth/login").send({ email: user.email, password }).expect(200);
      return { id: user.id, token: res.body.data.accessToken as string };
    };
    const a = await mk(tenantAId, UserRole.COMPLIANCE_OFFICER, "co-a", "Officer Alpha");
    coA = { ...a, name: "Officer Alpha" };
    coB = await mk(tenantAId, UserRole.COMPLIANCE_OFFICER, "co-b", "Officer Bravo");
    coC = await mk(tenantAId, UserRole.COMPLIANCE_OFFICER, "co-c", "Officer Charlie");
    roleTokens[UserRole.COMPLIANCE_OFFICER] = coC.token;
    for (const role of [UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.INVESTIGATOR, UserRole.VIEWER]) {
      roleTokens[role] = (await mk(tenantAId, role, `role-${role.toLowerCase()}`)).token;
    }
    tenantBOfficerToken = (await mk(tenantBId, UserRole.COMPLIANCE_OFFICER, "b-co")).token;
  });

  afterAll(async () => {
    await closeTestContext(ctx);
  });

  const http = () => request(ctx.app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  // ---------------------------------------------------------------- fixtures

  /** BVN is unique per tenant (uq_customer_tenant_bvn) and the dev DB persists across runs, so never hardcode one. */
  const digits = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join("");

  async function createCustomer(tenantId: string, overrides: Partial<CustomerEntity> = {}): Promise<CustomerEntity> {
    const repo = ctx.adminDataSource.getRepository(CustomerEntity);
    return repo.save(
      repo.create({
        tenantId,
        cbsCustomerId: `CUST-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        fullName: "Reports Test Customer",
        customerType: CustomerType.INDIVIDUAL,
        country: "NG",
        kycTier: 2,
        onboardedAt: new Date("2024-01-01"),
        isPep: false,
        isSanctioned: false,
        riskLevel: RiskLevel.LOW,
        lastRiskCalculatedAt: new Date(),
        ...overrides,
      }),
    );
  }

  async function createTransaction(tenantId: string, customerId: string, overrides: Partial<TransactionEntity> = {}): Promise<TransactionEntity> {
    const repo = ctx.adminDataSource.getRepository(TransactionEntity);
    return repo.save(
      repo.create({
        id: crypto.randomUUID(),
        tenantId,
        cbsTransactionId: `TXN-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        customerId,
        accountNumber: "0123456789",
        amount: "50000",
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
        occurredAt: new Date("2026-03-15T10:00:00Z"),
        source: TransactionSource.MANUAL,
        ingestionBatchId: null,
        ...overrides,
      }),
    );
  }

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

  async function createAlert(tenantId: string, customerId: string, relatedTransactionIds: string[]): Promise<AlertEntity> {
    const rule = await ctx.adminDataSource.getRepository(RuleEntity).findOneOrFail({ where: { tenantId, scenarioType: RuleScenarioType.LARGE_CASH } });
    const outcome = await withQr(tenantId, (qr) =>
      alertsService.createOrIncrement(qr, {
        tenantId,
        rule,
        customerId,
        triggeringTransactionId: null,
        severity: AlertSeverity.MEDIUM,
        title: "Reports-test alert",
        evidence: { relatedTransactionIds },
        dedupKey: `reports-test:${crypto.randomUUID()}`,
        firedAt: new Date(),
      }),
    );
    await ctx.adminDataSource.getRepository(AlertEntity).update({ id: outcome.alert.id }, { status: AlertStatus.ASSIGNED });
    return outcome.alert;
  }

  interface SarFixture {
    reportId: string;
    caseId: string;
    caseNumber: string;
    customer: CustomerEntity;
    transactions: TransactionEntity[];
  }

  /** Drives a real case all the way to SAR_FILED over HTTP (coA creates+approves, coB submits) so the draft SAR is produced by Cases.approve(). */
  async function makeSarReport(opts: { withTransactions?: boolean } = {}): Promise<SarFixture> {
    const withTransactions = opts.withTransactions ?? true;
    const customer = await createCustomer(tenantAId, {
      bvn: digits(11),
      nin: digits(11),
      dateOfBirth: new Date("1985-06-20"),
      nationality: "NG",
      occupation: "Trader",
    });
    // t2 is shared by both alerts: the flagged amount must count it once.
    const transactions = withTransactions
      ? [
          await createTransaction(tenantAId, customer.id, { amount: "1000.10", occurredAt: new Date("2026-03-01T09:00:00Z"), narration: "first & <second>" }),
          await createTransaction(tenantAId, customer.id, { amount: "2000.20", occurredAt: new Date("2026-03-02T09:00:00Z"), channel: TransactionChannel.CASH }),
          await createTransaction(tenantAId, customer.id, { amount: "500", occurredAt: new Date("2026-03-03T09:00:00Z") }),
        ]
      : [];
    const alert1 = await createAlert(tenantAId, customer.id, withTransactions ? [transactions[0].id, transactions[1].id] : []);
    const alert2 = await createAlert(tenantAId, customer.id, withTransactions ? [transactions[1].id, transactions[2].id] : []);

    const created = await http().post("/cases").set(auth(coA.token)).send({ alertId: alert1.id }).expect(201);
    const caseId: string = created.body.data.id;
    const caseNumber: string = created.body.data.caseNumber;
    await http().post(`/cases/${caseId}/alerts`).set(auth(coA.token)).send({ alertId: alert2.id }).expect(201);
    await http().post(`/cases/${caseId}/notes`).set(auth(coA.token)).send({ content: "First finding: structured deposits." }).expect(201);
    await new Promise((r) => setTimeout(r, 15));
    await http().post(`/cases/${caseId}/notes`).set(auth(coA.token)).send({ content: "Second finding: counterparty unknown." }).expect(201);
    await http().patch(`/cases/${caseId}/submit`).set(auth(coB.token)).send({ escalationRationale: "Pattern consistent with structuring." }).expect(200);
    await http().patch(`/cases/${caseId}/approve`).set(auth(coA.token)).expect(200);

    const report = await ctx.adminDataSource.getRepository(ReportEntity).findOneOrFail({ where: { tenantId: tenantAId, caseId } });
    return { reportId: report.id, caseId, caseNumber, customer, transactions };
  }

  interface CtrFixture {
    reportId: string;
    transaction: TransactionEntity;
    customer: CustomerEntity;
  }

  function ingestedEvent(tenantId: string, t: TransactionEntity) {
    return {
      tenantId,
      transactionId: t.id,
      customerId: t.customerId,
      amount: t.amount,
      currency: t.currency,
      type: t.type,
      channel: t.channel,
      counterpartyCustomerId: null,
      occurredAt: t.occurredAt.toISOString(),
      ingestionBatchId: crypto.randomUUID(),
      source: TransactionSource.MANUAL,
    };
  }

  /** Emits the real `transaction.ingested` event and returns the CTR the listener generated. */
  async function makeCtrReport(amount = "6000000"): Promise<CtrFixture> {
    const customer = await createCustomer(tenantAId, { bvn: digits(11), nin: digits(11), fullName: "Cash Depositor" });
    const transaction = await createTransaction(tenantAId, customer.id, { amount, channel: TransactionChannel.CASH, accountNumber: "0099887766" });
    await events.emitAsync("transaction.ingested", ingestedEvent(tenantAId, transaction));
    const report = await ctx.adminDataSource.getRepository(ReportEntity).findOneOrFail({ where: { tenantId: tenantAId, transactionId: transaction.id } });
    return { reportId: report.id, transaction, customer };
  }

  const reportRow = (id: string) => ctx.adminDataSource.getRepository(ReportEntity).findOneOrFail({ where: { id } });

  function getRaw(path: string, token: string, binary = false) {
    return http()
      .get(path)
      .set(auth(token))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          cb(null, binary ? buf : buf.toString("utf8"));
        });
      });
  }

  // ---------------------------------------------------------- SAR generation

  describe("SAR generation (Cases.approve -> draft Report)", () => {
    it("creates exactly one fully-populated SAR draft: deduplicated flaggedAmount, narrative from notes + rationale", async () => {
      const f = await makeSarReport();

      const rows = await ctx.adminDataSource.getRepository(ReportEntity).find({ where: { tenantId: tenantAId, caseId: f.caseId } });
      expect(rows).toHaveLength(1);
      const r = rows[0];
      expect(r.reportType).toBe(ReportType.SAR);
      expect(r.status).toBe(ReportStatus.DRAFT);
      expect(r.transactionId).toBeNull();
      expect(r.customerId).toBe(f.customer.id);
      expect(r.generatedBy).toBe(coA.id); // the approving officer
      expect(r.generatedAt).toBeInstanceOf(Date);
      expect(r.submittedBy).toBeNull();
      expect(r.confirmedBy).toBeNull();
      expect(r.nfiuReference).toBeNull();

      // 1000.10 + 2000.20 + 500.00 — the shared transaction is counted once (naive per-alert sum would give 5500.50).
      expect(r.flaggedAmount).toBe("3500.30");

      const n = r.narrative as string;
      expect(n).toContain(f.caseNumber);
      expect(n).toContain("Officer Alpha");
      expect(n).toContain("First finding: structured deposits.");
      expect(n).toContain("Second finding: counterparty unknown.");
      expect(n).toContain("Pattern consistent with structuring.");
      // chronological: notes in order, then the rationale
      expect(n.indexOf("First finding")).toBeLessThan(n.indexOf("Second finding"));
      expect(n.indexOf("Second finding")).toBeLessThan(n.indexOf("Pattern consistent"));
    });

    it("a case with no linked transactions gets a null flaggedAmount but still a narrative", async () => {
      const f = await makeSarReport({ withTransactions: false });
      const r = await reportRow(f.reportId);
      expect(r.flaggedAmount).toBeNull();
      expect(r.narrative).toContain(f.caseNumber);
    });

    it("audit-logs the generation with the approving officer as actor", async () => {
      const f = await makeSarReport();
      const audit = await ctx.adminDataSource.getRepository(AuditLogEntity).find({ where: { tenantId: tenantAId, entityId: f.reportId, action: "report.generated" } });
      expect(audit).toHaveLength(1);
      expect(audit[0].userId).toBe(coA.id);
    });

    it("GET /reports/:id returns the SAR with its linked case summary", async () => {
      const f = await makeSarReport();
      const res = await http().get(`/reports/${f.reportId}`).set(auth(roleTokens[UserRole.VIEWER])).expect(200);
      expect(res.body.data.reportType).toBe("SAR");
      expect(res.body.data.flaggedAmount).toBe(3500.3);
      expect(res.body.data.case).toMatchObject({ id: f.caseId, caseNumber: f.caseNumber, status: "SAR_FILED", escalationRationale: "Pattern consistent with structuring." });
      expect(res.body.data.transaction).toBeNull();
      expect(res.body.data.customer.id).toBe(f.customer.id);
    });
  });

  // ---------------------------------------------------------- CTR generation

  describe("CTR auto-generation (transaction.ingested listener)", () => {
    it("a qualifying CASH transaction (>= threshold) creates exactly one fully-populated CTR draft", async () => {
      const f = await makeCtrReport("6000000");
      const rows = await ctx.adminDataSource.getRepository(ReportEntity).find({ where: { tenantId: tenantAId, transactionId: f.transaction.id } });
      expect(rows).toHaveLength(1);
      const r = rows[0];
      expect(r.reportType).toBe(ReportType.CTR);
      expect(r.status).toBe(ReportStatus.DRAFT);
      expect(r.caseId).toBeNull();
      expect(r.customerId).toBe(f.customer.id);
      expect(r.generatedBy).toBeNull(); // system-generated
      expect(r.flaggedAmount).toBe("6000000.00");
      expect(r.narrative).toContain("Cash transaction of ₦6,000,000.00");
      expect(r.narrative).toContain("Cash Depositor");
      expect(r.narrative).toContain("2026-03-15");
      expect(r.narrative).toContain("via CASH");
      expect(r.narrative).toContain("₦5,000,000.00 reporting threshold");

      const audit = await ctx.adminDataSource.getRepository(AuditLogEntity).find({ where: { tenantId: tenantAId, entityId: r.id, action: "report.generated" } });
      expect(audit).toHaveLength(1);
      expect(audit[0].userId).toBeNull();
    });

    it("exactly at the threshold qualifies; just below does not", async () => {
      const c = await createCustomer(tenantAId);
      const at = await createTransaction(tenantAId, c.id, { amount: "5000000", channel: TransactionChannel.CASH });
      const below = await createTransaction(tenantAId, c.id, { amount: "4999999.99", channel: TransactionChannel.CASH });
      await events.emitAsync("transaction.ingested", ingestedEvent(tenantAId, at));
      await events.emitAsync("transaction.ingested", ingestedEvent(tenantAId, below));
      const repo = ctx.adminDataSource.getRepository(ReportEntity);
      expect(await repo.count({ where: { transactionId: at.id } })).toBe(1);
      expect(await repo.count({ where: { transactionId: below.id } })).toBe(0);
    });

    it("non-qualifying transactions create no CTR: non-CASH channel, foreign currency, corporate customer under the corporate threshold", async () => {
      const c = await createCustomer(tenantAId);
      const corp = await createCustomer(tenantAId, { customerType: CustomerType.CORPORATE });
      const wire = await createTransaction(tenantAId, c.id, { amount: "9000000", channel: TransactionChannel.MOBILE });
      const usd = await createTransaction(tenantAId, c.id, { amount: "9000000", channel: TransactionChannel.CASH, currency: "USD" });
      const corpCash = await createTransaction(tenantAId, corp.id, { amount: "6000000", channel: TransactionChannel.CASH });
      for (const t of [wire, usd, corpCash]) await events.emitAsync("transaction.ingested", ingestedEvent(tenantAId, t));
      const repo = ctx.adminDataSource.getRepository(ReportEntity);
      for (const t of [wire, usd, corpCash]) expect(await repo.count({ where: { transactionId: t.id } })).toBe(0);
    });

    it("reads the threshold from the tenant's own LARGE_CASH rule config, not a hardcoded value (and honours it even when the rule is deactivated)", async () => {
      const tenantC = await createTenantFixture(ctx.adminDataSource);
      const [rule] = (await seedRuleCatalogFixture(ctx.adminDataSource, tenantC.id, { LARGE_CASH: { thresholdIndividual: 1000 } })).filter(
        (r) => r.scenarioType === RuleScenarioType.LARGE_CASH,
      );
      await ctx.adminDataSource.getRepository(RuleEntity).update({ id: rule.id }, { isActive: false });
      const c = await createCustomer(tenantC.id);
      const t = await createTransaction(tenantC.id, c.id, { amount: "2500", channel: TransactionChannel.CASH });
      await events.emitAsync("transaction.ingested", ingestedEvent(tenantC.id, t));
      const r = await ctx.adminDataSource.getRepository(ReportEntity).findOneOrFail({ where: { transactionId: t.id } });
      expect(r.narrative).toContain("₦1,000.00 reporting threshold");
    });

    it("falls back to the default LARGE_CASH config when the tenant has no rule row", async () => {
      const tenantD = await createTenantFixture(ctx.adminDataSource); // deliberately no seedRuleCatalogFixture
      const c = await createCustomer(tenantD.id);
      const t = await createTransaction(tenantD.id, c.id, { amount: "5000000", channel: TransactionChannel.CASH });
      await events.emitAsync("transaction.ingested", ingestedEvent(tenantD.id, t));
      expect(await ctx.adminDataSource.getRepository(ReportEntity).count({ where: { transactionId: t.id } })).toBe(1);
    });

    it("idempotent: the same event fired twice — sequentially and concurrently — produces exactly one CTR", async () => {
      const c = await createCustomer(tenantAId);
      const t = await createTransaction(tenantAId, c.id, { amount: "7000000", channel: TransactionChannel.CASH });
      const ev = ingestedEvent(tenantAId, t);
      await events.emitAsync("transaction.ingested", ev);
      await events.emitAsync("transaction.ingested", ev);
      await Promise.all([events.emitAsync("transaction.ingested", ev), events.emitAsync("transaction.ingested", ev)]);
      const repo = ctx.adminDataSource.getRepository(ReportEntity);
      expect(await repo.count({ where: { transactionId: t.id } })).toBe(1);
      const audit = await ctx.adminDataSource.getRepository(AuditLogEntity).count({
        where: { tenantId: tenantAId, action: "report.generated", entityId: (await repo.findOneOrFail({ where: { transactionId: t.id } })).id },
      });
      expect(audit).toBe(1);
    });

    it("a malformed event (no transactionId) is ignored — it must not match some arbitrary transaction of the tenant", async () => {
      const c = await createCustomer(tenantAId);
      // A qualifying, not-yet-reported cash transaction that an `undefined` where-clause would happily match.
      const bait = await createTransaction(tenantAId, c.id, { amount: "9000000", channel: TransactionChannel.CASH });
      await events.emitAsync("transaction.ingested", {
        tenantId: tenantAId,
        customerId: c.id,
        amount: "9000000",
        currency: "NGN",
        type: TransactionType.CREDIT,
        channel: TransactionChannel.CASH,
      });
      expect(await ctx.adminDataSource.getRepository(ReportEntity).count({ where: { transactionId: bait.id } })).toBe(0);
    });

    it("the DB itself rejects a second CTR for one transaction, a second SAR for one case, and a row with both/neither subject", async () => {
      const f = await makeCtrReport();
      const sar = await makeSarReport();
      const insert = (over: Record<string, unknown>) =>
        ctx.adminDataSource.query(
          `INSERT INTO report (tenant_id, customer_id, report_type, status, generated_at, case_id, transaction_id)
           VALUES ($1, $2, $3, 'DRAFT', now(), $4, $5)`,
          [tenantAId, f.customer.id, over.type, over.caseId ?? null, over.transactionId ?? null],
        );
      await expect(insert({ type: "CTR", transactionId: f.transaction.id })).rejects.toThrow(/uq_report_transaction_id/);
      await expect(insert({ type: "SAR", caseId: sar.caseId })).rejects.toThrow(/uq_report_case_id/);
      await expect(insert({ type: "SAR", caseId: crypto.randomUUID(), transactionId: crypto.randomUUID() })).rejects.toThrow(/ck_report_subject/);
      await expect(insert({ type: "SAR" })).rejects.toThrow(/ck_report_subject/);
      await expect(insert({ type: "CTR", caseId: crypto.randomUUID() })).rejects.toThrow(/ck_report_subject/); // type/subject mismatch
    });

    it("GET /reports/:id returns the CTR with its linked transaction summary", async () => {
      const f = await makeCtrReport();
      const res = await http().get(`/reports/${f.reportId}`).set(auth(roleTokens[UserRole.INVESTIGATOR])).expect(200);
      expect(res.body.data.reportType).toBe("CTR");
      expect(res.body.data.case).toBeNull();
      expect(res.body.data.generatedBy).toBeNull();
      expect(res.body.data.transaction).toMatchObject({ id: f.transaction.id, accountNumber: "0099887766", amount: "6000000.00", channel: "CASH" });
    });
  });

  // ----------------------------------------------------------------- editing

  describe("PATCH /reports/:id — editing a draft", () => {
    it("edits narrative and flaggedAmount while DRAFT (SAR and CTR), audit-logged", async () => {
      const sar = await makeSarReport();
      const res = await http().patch(`/reports/${sar.reportId}`).set(auth(coC.token)).send({ narrative: "Rewritten narrative.", flaggedAmount: 1234.5 }).expect(200);
      expect(res.body.data.narrative).toBe("Rewritten narrative.");
      expect(res.body.data.flaggedAmount).toBe(1234.5);
      expect((await reportRow(sar.reportId)).flaggedAmount).toBe("1234.50");
      expect(await ctx.adminDataSource.getRepository(AuditLogEntity).count({ where: { entityId: sar.reportId, action: "report.edited" } })).toBe(1);

      const ctr = await makeCtrReport();
      await http().patch(`/reports/${ctr.reportId}`).set(auth(coC.token)).send({ narrative: "Corrected CTR narrative." }).expect(200);
      expect((await reportRow(ctr.reportId)).narrative).toBe("Corrected CTR narrative.");
    });

    it("rejects any other field, a bad amount, and an empty body with 400", async () => {
      const sar = await makeSarReport();
      const patch = (body: object) => http().patch(`/reports/${sar.reportId}`).set(auth(coC.token)).send(body);
      await patch({ status: "SUBMITTED" }).expect(400);
      await patch({ nfiuReference: "X" }).expect(400);
      await patch({ flaggedAmount: -5 }).expect(400);
      await patch({ flaggedAmount: 10.123 }).expect(400);
      const res = await patch({}).expect(400);
      expect(res.body.error.code).toBe("NO_EDITABLE_FIELDS");
      expect((await reportRow(sar.reportId)).status).toBe(ReportStatus.DRAFT);
    });

    it("409 REPORT_NOT_EDITABLE on PENDING_CONFIRMATION and on SUBMITTED; nothing changes", async () => {
      const sar = await makeSarReport();
      await http().patch(`/reports/${sar.reportId}/submit`).set(auth(coA.token)).expect(200);
      const before = await reportRow(sar.reportId);
      let res = await http().patch(`/reports/${sar.reportId}`).set(auth(coC.token)).send({ narrative: "sneaky" }).expect(409);
      expect(res.body.error.code).toBe("REPORT_NOT_EDITABLE");
      res = await http().patch(`/reports/${sar.reportId}`).set(auth(coC.token)).send({ flaggedAmount: 1 }).expect(409);
      expect(res.body.error.code).toBe("REPORT_NOT_EDITABLE");
      const after = await reportRow(sar.reportId);
      expect(after.narrative).toBe(before.narrative);
      expect(after.flaggedAmount).toBe(before.flaggedAmount);

      await http().patch(`/reports/${sar.reportId}/confirm`).set(auth(coB.token)).send({ nfiuReference: "NFIU-1" }).expect(200);
      res = await http().patch(`/reports/${sar.reportId}`).set(auth(coC.token)).send({ narrative: "too late" }).expect(409);
      expect(res.body.error.code).toBe("REPORT_NOT_EDITABLE");
    });
  });

  // ------------------------------------------------------ SAR maker-checker

  describe("SAR two-person maker-checker", () => {
    it("submit -> submitter cannot confirm -> a different officer confirms", async () => {
      const sar = await makeSarReport();

      const submitted = await http().patch(`/reports/${sar.reportId}/submit`).set(auth(coA.token)).expect(200);
      expect(submitted.body.data.status).toBe("PENDING_CONFIRMATION");
      expect(submitted.body.data.submittedBy).toBe(coA.id);
      expect(submitted.body.data.submittedAt).toEqual(expect.any(String));

      const self = await http().patch(`/reports/${sar.reportId}/confirm`).set(auth(coA.token)).send({ nfiuReference: "NFIU-SELF" }).expect(403);
      expect(self.body.error.code).toBe("CONFIRMER_CANNOT_BE_SUBMITTER");
      expect((await reportRow(sar.reportId)).status).toBe(ReportStatus.PENDING_CONFIRMATION);

      const noRef = await http().patch(`/reports/${sar.reportId}/confirm`).set(auth(coB.token)).send({ nfiuReference: "   " }).expect(400);
      expect(noRef.body.error.code).toBe("NFIU_REFERENCE_REQUIRED");
      await http().patch(`/reports/${sar.reportId}/confirm`).set(auth(coB.token)).send({}).expect(400);

      const done = await http().patch(`/reports/${sar.reportId}/confirm`).set(auth(coB.token)).send({ nfiuReference: "NFIU-2026-0001" }).expect(200);
      expect(done.body.data).toMatchObject({ status: "SUBMITTED", confirmedBy: coB.id, nfiuReference: "NFIU-2026-0001", submittedBy: coA.id });
      expect(done.body.data.confirmedAt).toEqual(expect.any(String));
    });

    it("confirm/reject from DRAFT and submit from a non-DRAFT state are 409 INVALID_TRANSITION", async () => {
      const sar = await makeSarReport();
      let res = await http().patch(`/reports/${sar.reportId}/confirm`).set(auth(coB.token)).send({ nfiuReference: "X" }).expect(409);
      expect(res.body.error.code).toBe("INVALID_TRANSITION");
      res = await http().patch(`/reports/${sar.reportId}/reject`).set(auth(coB.token)).send({ reason: "r" }).expect(409);
      expect(res.body.error.code).toBe("INVALID_TRANSITION");
      await http().patch(`/reports/${sar.reportId}/submit`).set(auth(coA.token)).expect(200);
      res = await http().patch(`/reports/${sar.reportId}/submit`).set(auth(coB.token)).expect(409);
      expect(res.body.error.code).toBe("INVALID_TRANSITION");
    });

    it("reject -> back to DRAFT with submittedBy/submittedAt cleared, fields editable again, and resubmission works cleanly", async () => {
      const sar = await makeSarReport();
      await http().patch(`/reports/${sar.reportId}/submit`).set(auth(coA.token)).expect(200);

      const self = await http().patch(`/reports/${sar.reportId}/reject`).set(auth(coA.token)).send({ reason: "changed my mind" }).expect(403);
      expect(self.body.error.code).toBe("CONFIRMER_CANNOT_BE_SUBMITTER");

      const noReason = await http().patch(`/reports/${sar.reportId}/reject`).set(auth(coB.token)).send({ reason: "" }).expect(400);
      expect(noReason.body.error.code).toBe("REJECTION_REASON_REQUIRED");
      await http().patch(`/reports/${sar.reportId}/reject`).set(auth(coB.token)).send({}).expect(400);

      const rejected = await http().patch(`/reports/${sar.reportId}/reject`).set(auth(coB.token)).send({ reason: "Narrative lacks detail." }).expect(200);
      expect(rejected.body.data).toMatchObject({ status: "DRAFT", submittedBy: null, submittedAt: null, confirmedBy: null });
      const audit = await ctx.adminDataSource.getRepository(AuditLogEntity).findOneOrFail({ where: { entityId: sar.reportId, action: "report.rejected" } });
      expect((audit.afterState as { reason: string }).reason).toBe("Narrative lacks detail.");

      // editable again
      await http().patch(`/reports/${sar.reportId}`).set(auth(coC.token)).send({ narrative: "Much better narrative." }).expect(200);

      // no silent resume: confirming straight after a reject is invalid; a genuine resubmit (this time by coB) is required
      await http().patch(`/reports/${sar.reportId}/confirm`).set(auth(coA.token)).send({ nfiuReference: "X" }).expect(409);
      const resub = await http().patch(`/reports/${sar.reportId}/submit`).set(auth(coB.token)).expect(200);
      expect(resub.body.data.submittedBy).toBe(coB.id);
      // coA — the original submitter — may now confirm, coB (the new submitter) may not
      await http().patch(`/reports/${sar.reportId}/confirm`).set(auth(coB.token)).send({ nfiuReference: "X" }).expect(403);
      const done = await http().patch(`/reports/${sar.reportId}/confirm`).set(auth(coA.token)).send({ nfiuReference: "NFIU-RESUB" }).expect(200);
      expect(done.body.data.status).toBe("SUBMITTED");
      expect(done.body.data.narrative).toBe("Much better narrative.");
    });

    it("400 WRONG_REPORT_TYPE when submit is called on a CTR", async () => {
      const ctr = await makeCtrReport();
      const res = await http().patch(`/reports/${ctr.reportId}/submit`).set(auth(coA.token)).expect(400);
      expect(res.body.error.code).toBe("WRONG_REPORT_TYPE");
      expect((await reportRow(ctr.reportId)).status).toBe(ReportStatus.DRAFT);
    });
  });

  // ------------------------------------------------------- CTR single-confirmer

  describe("CTR single-confirmer flow", () => {
    it("one officer confirms straight from DRAFT — no submitter, no submitter guard, any officer may do it", async () => {
      const ctr = await makeCtrReport();
      const res = await http().patch(`/reports/${ctr.reportId}/confirm`).set(auth(coA.token)).send({ nfiuReference: "NFIU-CTR-1" }).expect(200);
      expect(res.body.data).toMatchObject({ status: "SUBMITTED", confirmedBy: coA.id, nfiuReference: "NFIU-CTR-1", submittedBy: null, generatedBy: null });
      expect(res.body.data.confirmedAt).toEqual(expect.any(String));
    });

    it("confirm requires an NFIU reference (400) and cannot be repeated (409)", async () => {
      const ctr = await makeCtrReport();
      const res = await http().patch(`/reports/${ctr.reportId}/confirm`).set(auth(coA.token)).send({ nfiuReference: "" }).expect(400);
      expect(res.body.error.code).toBe("NFIU_REFERENCE_REQUIRED");
      expect((await reportRow(ctr.reportId)).status).toBe(ReportStatus.DRAFT);
      await http().patch(`/reports/${ctr.reportId}/confirm`).set(auth(coA.token)).send({ nfiuReference: "N1" }).expect(200);
      const again = await http().patch(`/reports/${ctr.reportId}/confirm`).set(auth(coB.token)).send({ nfiuReference: "N2" }).expect(409);
      expect(again.body.error.code).toBe("INVALID_TRANSITION");
      expect((await reportRow(ctr.reportId)).nfiuReference).toBe("N1");
    });

    it("reject records the reason, leaves the CTR an editable DRAFT, and it can be corrected then confirmed", async () => {
      const ctr = await makeCtrReport();
      const noReason = await http().patch(`/reports/${ctr.reportId}/reject`).set(auth(coA.token)).send({}).expect(400);
      expect(noReason.body.error.code).toBe("REJECTION_REASON_REQUIRED");

      const rej = await http().patch(`/reports/${ctr.reportId}/reject`).set(auth(coA.token)).send({ reason: "Wrong account number." }).expect(200);
      expect(rej.body.data).toMatchObject({ status: "DRAFT", submittedBy: null });
      const audit = await ctx.adminDataSource.getRepository(AuditLogEntity).findOneOrFail({ where: { entityId: ctr.reportId, action: "report.rejected" } });
      expect((audit.afterState as { reason: string }).reason).toBe("Wrong account number.");

      await http().patch(`/reports/${ctr.reportId}`).set(auth(coA.token)).send({ narrative: "Corrected." }).expect(200);
      const done = await http().patch(`/reports/${ctr.reportId}/confirm`).set(auth(coA.token)).send({ nfiuReference: "NFIU-CTR-2" }).expect(200);
      expect(done.body.data).toMatchObject({ status: "SUBMITTED", narrative: "Corrected." });
    });
  });

  // ----------------------------------------------------------- immutability

  describe("immutability once SUBMITTED", () => {
    async function submittedReports(): Promise<{ sar: string; ctr: string }> {
      const sar = await makeSarReport();
      await http().patch(`/reports/${sar.reportId}/submit`).set(auth(coA.token)).expect(200);
      await http().patch(`/reports/${sar.reportId}/confirm`).set(auth(coB.token)).send({ nfiuReference: "LOCK-SAR" }).expect(200);
      const ctr = await makeCtrReport();
      await http().patch(`/reports/${ctr.reportId}/confirm`).set(auth(coA.token)).send({ nfiuReference: "LOCK-CTR" }).expect(200);
      return { sar: sar.reportId, ctr: ctr.reportId };
    }

    it("no role can change any field or transition a SUBMITTED report, and the row is byte-for-byte unchanged", async () => {
      const ids = await submittedReports();
      for (const id of [ids.sar, ids.ctr]) {
        const before = JSON.stringify(await reportRow(id));
        for (const role of Object.values(UserRole)) {
          const token = roleTokens[role];
          // Factories, not pre-built requests: supertest closes its ephemeral listener after each awaited request.
          const attempts = [
            () => http().patch(`/reports/${id}`).set(auth(token)).send({ narrative: "tamper", flaggedAmount: 1 }),
            () => http().patch(`/reports/${id}/submit`).set(auth(token)),
            () => http().patch(`/reports/${id}/confirm`).set(auth(token)).send({ nfiuReference: "tamper" }),
            () => http().patch(`/reports/${id}/reject`).set(auth(token)).send({ reason: "tamper" }),
          ];
          for (const attempt of attempts) {
            const res = await attempt();
            // Compliance Officer reaches the state check (409, or 400 for submit-on-CTR); every other role is stopped at the role gate (403).
            const expected = role === UserRole.COMPLIANCE_OFFICER ? [409, 400] : [403];
            expect(expected).toContain(res.status);
          }
        }
        expect(JSON.stringify(await reportRow(id))).toBe(before);
      }
    });

    it("SUBMITTED reports stay downloadable and readable", async () => {
      const ids = await submittedReports();
      const res = await http().get(`/reports/${ids.sar}`).set(auth(roleTokens[UserRole.VIEWER])).expect(200);
      expect(res.body.data.status).toBe("SUBMITTED");
      await http().get(`/reports/${ids.ctr}/csv`).set(auth(roleTokens[UserRole.VIEWER])).expect(200);
    });
  });

  // -------------------------------------------------------------- downloads

  describe("downloads", () => {
    it("SAR XML carries real customer, transaction, amount and narrative data — and never claims schema validity", async () => {
      const f = await makeSarReport();
      const res = await getRaw(`/reports/${f.reportId}/xml?reason=audit`, roleTokens[UserRole.TENANT_ADMIN]).expect(200);
      const xml = res.body as string;

      expect(res.headers["content-type"]).toMatch(/application\/xml/);
      expect(res.headers["content-disposition"]).toMatch(/attachment; filename="SAR-.*\.xml"/);
      expect(res.headers["cache-control"]).toBe("no-store");

      expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
      expect(xml).toContain("<suspicious_activity_report>");
      // reporting entity: what Tenant genuinely has
      expect(xml).toContain("<name>Reports Test MFB</name>");
      expect(xml).toContain("<cbn_license_number>MFB-LIC-7777</cbn_license_number>");
      // customer demographics incl. UNMASKED BVN/NIN
      expect(xml).toContain("<full_name>Reports Test Customer</full_name>");
      expect(xml).toContain("<date_of_birth>1985-06-20</date_of_birth>");
      expect(xml).toContain("<nationality>NG</nationality>");
      expect(xml).toContain("<occupation>Trader</occupation>");
      expect(xml).toContain(`<bvn>${f.customer.bvn}</bvn>`);
      expect(xml).toContain(`<nin>${f.customer.nin}</nin>`);
      // structured amount + escalation rationale
      expect(xml).toContain('<flagged_amount currency="NGN">3500.30</flagged_amount>');
      expect(xml).toContain(`<case_number>${f.caseNumber}</case_number>`);
      expect(xml).toContain("<escalation_rationale>Pattern consistent with structuring.</escalation_rationale>");
      // every derived transaction, once each, with structured fields; XML-special characters escaped
      expect(xml).toContain('<transactions count="3">');
      for (const t of f.transactions) expect(xml).toContain(`<transaction_id>${t.id}</transaction_id>`);
      expect(xml).toContain('<amount currency="NGN">1000.10</amount>');
      expect(xml).toContain('<amount currency="NGN">2000.20</amount>');
      expect(xml).toContain("<account_number>0123456789</account_number>");
      expect(xml).toContain("<narration>first &amp; &lt;second&gt;</narration>");
      expect(xml).toContain("<narrative>");
      expect(xml).toContain("First finding: structured deposits.");
      // reporting officer (generator) identified
      expect(xml).toContain("<full_name>Officer Alpha</full_name>");

      // Section 2.4: no claim of schema validity — the only statement is an explicit disclaimer.
      expect(xml).toContain("NOT GOAML SCHEMA CONFORMANT");
      expect(xml).not.toMatch(/xsi:|xmlns|schemaLocation|xmlValidated|validated="true"|schema[-_ ]?valid(?!ation)/i);
      expect(JSON.stringify(res.headers)).not.toMatch(/valid|goaml/i);
    });

    it("CTR XML holds the one qualifying transaction's full detail and the confirmed NFIU reference", async () => {
      const f = await makeCtrReport("8250000.5");
      await http().patch(`/reports/${f.reportId}/confirm`).set(auth(coA.token)).send({ nfiuReference: "NFIU-CTR-XML" }).expect(200);
      const xml = (await getRaw(`/reports/${f.reportId}/xml?reason=audit`, coC.token).expect(200)).body as string;
      expect(xml).toContain("<currency_transaction_report>");
      expect(xml).toContain("<nfiu_reference>NFIU-CTR-XML</nfiu_reference>");
      expect(xml).toContain('<transactions count="1">');
      expect(xml).toContain(`<transaction_id>${f.transaction.id}</transaction_id>`);
      expect(xml).toContain('<amount currency="NGN">8250000.50</amount>');
      expect(xml).toContain("<channel>CASH</channel>");
      expect(xml).toContain("<account_number>0099887766</account_number>");
      expect(xml).toContain("<date>2026-03-15T10:00:00.000Z</date>");
      expect(xml).toContain(`<bvn>${f.customer.bvn}</bvn>`);
      expect(xml).toContain('<transaction_amount currency="NGN">8250000.50</transaction_amount>');
      expect(xml).toContain("Cash transaction of ₦8,250,000.50");
      expect(xml).not.toContain("<escalation_rationale>");
    });

    it("audit-logs every export, and the XML's BVN/NIN unmask under the same action the PII-reveal endpoint uses", async () => {
      const f = await makeSarReport();
      await getRaw(`/reports/${f.reportId}/xml?reason=audit`, coC.token).expect(200);
      await getRaw(`/reports/${f.reportId}/csv`, coC.token).expect(200);

      const audit = await ctx.adminDataSource.getRepository(AuditLogEntity).find({ where: { tenantId: tenantAId }, order: { createdAt: "ASC" } });
      const exports = audit.filter((a) => a.action === "report.exported" && a.entityId === f.reportId);
      expect(exports.map((a) => (a.afterState as { format: string }).format).sort()).toEqual(["csv", "xml"]);
      const reveals = audit.filter((a) => a.action === "customer.pii.view" && a.entityId === f.customer.id);
      expect(reveals).toHaveLength(1); // only the XML, not the CSV
      expect(reveals[0].userId).toBe(coC.id);
      expect(reveals[0].afterState).toMatchObject({ reportId: f.reportId, fields: ["bvn", "nin"] });
    });

    it("PDF is a real PDF document", async () => {
      const f = await makeSarReport();
      const res = await getRaw(`/reports/${f.reportId}/pdf`, roleTokens[UserRole.TENANT_ADMIN], true).expect(200);
      const buf = res.body as Buffer;
      expect(res.headers["content-type"]).toMatch(/application\/pdf/);
      expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
      expect(buf.subarray(-16).toString()).toContain("%%EOF");
      expect(buf.length).toBeGreaterThan(1000);
    });

    it("CSV has report fields and one row per transaction, with BVN/NIN masked and formula-looking text neutralised", async () => {
      const f = await makeSarReport();
      await http().patch(`/reports/${f.reportId}`).set(auth(coC.token)).send({ narrative: '=HYPERLINK("http://evil"), "quoted"' }).expect(200);
      const res = await getRaw(`/reports/${f.reportId}/csv`, roleTokens[UserRole.INVESTIGATOR]).expect(200);
      const csv = res.body as string;
      expect(res.headers["content-type"]).toMatch(/text\/csv/);
      expect(csv.split("\r\n")[0]).toBe("field,value");
      expect(csv).toContain(`report_id,${f.reportId}`);
      expect(csv).toContain("report_type,SAR");
      expect(csv).toContain("flagged_amount,3500.30");
      expect(csv).toContain(`bvn_masked,*******${f.customer.bvn!.slice(-4)}`);
      expect(csv).not.toContain(f.customer.bvn!);
      expect(csv).not.toContain(f.customer.nin!);
      for (const t of f.transactions) expect(csv).toContain(t.id);
      expect(csv).toContain(`narrative,"'=HYPERLINK(""http://evil""), ""quoted"""`);
    });

    it("PDF and CSV (BVN/NIN masked) are open to all five roles; a cross-tenant download is 404", async () => {
      const f = await makeSarReport();
      for (const role of Object.values(UserRole)) {
        await getRaw(`/reports/${f.reportId}/pdf`, roleTokens[role], true).expect(200);
        const csv = (await getRaw(`/reports/${f.reportId}/csv`, roleTokens[role]).expect(200)).body as string;
        expect(csv).not.toContain(f.customer.bvn!);
        expect(csv).not.toContain(f.customer.nin!);
      }
      await http().get(`/reports/${f.reportId}/xml?reason=audit`).set(auth(tenantBOfficerToken)).expect(404);
    });

    it("XML (unmasked BVN/NIN) is gated like GET /customers/:id/pii: INVESTIGATOR/VIEWER get 403, and nothing is exported or audit-logged", async () => {
      const f = await makeSarReport();
      const count = (entityId: string, action: string) => ctx.adminDataSource.getRepository(AuditLogEntity).count({ where: { tenantId: tenantAId, entityId, action } });
      for (const role of [UserRole.INVESTIGATOR, UserRole.VIEWER]) {
        const res = await http().get(`/reports/${f.reportId}/xml?reason=audit`).set(auth(roleTokens[role])).expect(403);
        expect(res.body.error.code).toBe("FORBIDDEN_ROLE");
        expect(res.text).not.toContain(f.customer.bvn!);
      }
      expect(await count(f.reportId, "report.exported")).toBe(0);
      expect(await count(f.customer.id, "customer.pii.view")).toBe(0);
      for (const role of [UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.COMPLIANCE_OFFICER]) {
        const xml = (await getRaw(`/reports/${f.reportId}/xml?reason=audit`, roleTokens[role]).expect(200)).body as string;
        expect(xml).toContain(`<bvn>${f.customer.bvn}</bvn>`);
      }
      expect(await count(f.customer.id, "customer.pii.view")).toBe(3);
    });

    it("XML requires a non-empty `reason` (same as GET /customers/:id/pii): 400 REASON_REQUIRED, nothing exported; the reason is recorded in the audit log", async () => {
      const f = await makeSarReport();
      const count = (entityId: string, action: string) => ctx.adminDataSource.getRepository(AuditLogEntity).count({ where: { tenantId: tenantAId, entityId, action } });
      for (const url of [`/reports/${f.reportId}/xml`, `/reports/${f.reportId}/xml?reason=`]) {
        const res = await http().get(url).set(auth(coC.token)).expect(400);
        expect(res.body.error.code).toBe("REASON_REQUIRED");
        expect(res.text).not.toContain(f.customer.bvn!);
      }
      // the role gate still comes first: a forbidden role without a reason is 403, not 400
      await http().get(`/reports/${f.reportId}/xml`).set(auth(roleTokens[UserRole.VIEWER])).expect(403);
      expect(await count(f.reportId, "report.exported")).toBe(0);
      expect(await count(f.customer.id, "customer.pii.view")).toBe(0);

      await getRaw(`/reports/${f.reportId}/xml?reason=${encodeURIComponent("NFIU filing prep, ticket 42")}`, coC.token).expect(200);
      const pii = await ctx.adminDataSource.getRepository(AuditLogEntity).findOneOrFail({ where: { tenantId: tenantAId, entityId: f.customer.id, action: "customer.pii.view" } });
      expect(pii.afterState).toMatchObject({ reason: "NFIU filing prep, ticket 42", reportId: f.reportId });
      const exp = await ctx.adminDataSource.getRepository(AuditLogEntity).findOneOrFail({ where: { tenantId: tenantAId, entityId: f.reportId, action: "report.exported" } });
      expect(exp.afterState).toMatchObject({ format: "xml", reason: "NFIU filing prep, ticket 42" });

      // PDF/CSV (masked) need no reason
      await getRaw(`/reports/${f.reportId}/csv`, coC.token).expect(200);
    });
  });

  // ------------------------------------------------------------- list/detail

  describe("GET /reports", () => {
    it("filters by reportType, status and date range and paginates; only the caller's tenant is visible", async () => {
      const sar = await makeSarReport();
      const ctr = await makeCtrReport();
      await http().patch(`/reports/${ctr.reportId}/confirm`).set(auth(coA.token)).send({ nfiuReference: "L1" }).expect(200);

      const q = (query: Record<string, string | number>, token = roleTokens[UserRole.VIEWER]) => http().get("/reports").query(query).set(auth(token)).expect(200);

      const sars = await q({ reportType: "SAR", limit: 100 });
      expect(sars.body.data.data.every((r: { reportType: string }) => r.reportType === "SAR")).toBe(true);
      expect(sars.body.data.data.map((r: { id: string }) => r.id)).toContain(sar.reportId);
      expect(sars.body.data.data.map((r: { id: string }) => r.id)).not.toContain(ctr.reportId);

      const submitted = await q({ status: "SUBMITTED", limit: 100 });
      expect(submitted.body.data.data.map((r: { id: string }) => r.id)).toContain(ctr.reportId);
      expect(submitted.body.data.data.every((r: { status: string }) => r.status === "SUBMITTED")).toBe(true);

      const future = await q({ dateFrom: new Date(Date.now() + 86_400_000).toISOString() });
      expect(future.body.data.data).toHaveLength(0);
      expect(future.body.data.meta.total).toBe(0);
      const window = await q({ dateFrom: new Date(Date.now() - 3_600_000).toISOString(), dateTo: new Date(Date.now() + 3_600_000).toISOString(), limit: 100 });
      expect(window.body.data.data.map((r: { id: string }) => r.id)).toEqual(expect.arrayContaining([sar.reportId, ctr.reportId]));

      const page = await q({ limit: 2, page: 1 });
      expect(page.body.data.data).toHaveLength(2);
      expect(page.body.data.meta).toMatchObject({ page: 1, limit: 2 });
      expect(page.body.data.meta.total).toBeGreaterThan(2);

      const other = await q({ limit: 100 }, tenantBOfficerToken);
      expect(other.body.data.data).toHaveLength(0);

      await http().get("/reports").query({ status: "BOGUS" }).set(auth(coA.token)).expect(400);
    });
  });

  // -------------------------------------------------------- tenant isolation

  describe("tenant isolation — every endpoint 404s cross-tenant", () => {
    it("tenant B's Compliance Officer gets 404 (not 403) on all 8 :id endpoints (detail, edit, submit, confirm, reject, xml, pdf, csv) for tenant A's SAR and CTR, and nothing changes", async () => {
      const sar = await makeSarReport();
      const ctr = await makeCtrReport();
      for (const id of [sar.reportId, ctr.reportId]) {
        const before = JSON.stringify(await reportRow(id));
        const calls = [
          () => http().get(`/reports/${id}`),
          () => http().patch(`/reports/${id}`).send({ narrative: "x" }),
          () => http().patch(`/reports/${id}/submit`),
          () => http().patch(`/reports/${id}/confirm`).send({ nfiuReference: "x" }),
          () => http().patch(`/reports/${id}/reject`).send({ reason: "x" }),
          () => http().get(`/reports/${id}/xml?reason=audit`),
          () => http().get(`/reports/${id}/pdf`),
          () => http().get(`/reports/${id}/csv`),
        ];
        for (const call of calls) {
          const res = await call().set(auth(tenantBOfficerToken));
          expect(res.status).toBe(404);
        }
        expect(JSON.stringify(await reportRow(id))).toBe(before);
      }
      // The 9th endpoint, GET /reports, never leaks them (asserted in the GET /reports block); a malformed id is a 400, not a 500
      await http().get("/reports/not-a-uuid").set(auth(coA.token)).expect(400);
    });

    it("RLS backstop: a raw regops_app connection with no tenant context sees zero report rows", async () => {
      await makeSarReport();
      const raw = new DataSource({ type: "postgres", url: process.env.DATABASE_URL });
      await raw.initialize();
      try {
        const rows = await raw.query(`SELECT id FROM report`);
        expect(rows).toHaveLength(0);
      } finally {
        await raw.destroy();
      }
    });
  });

  // -------------------------------------------------------------- role gates

  describe("role gates — every endpoint against every role", () => {
    const READ_ENDPOINTS = ["", "/csv", "/pdf"];

    it("reads (list, detail, pdf, csv) are open to all five roles; xml only to SUPER_ADMIN/TENANT_ADMIN/COMPLIANCE_OFFICER", async () => {
      const f = await makeSarReport();
      for (const role of Object.values(UserRole)) {
        await http().get("/reports").set(auth(roleTokens[role])).expect(200);
        for (const suffix of READ_ENDPOINTS) {
          await getRaw(`/reports/${f.reportId}${suffix}`, roleTokens[role], suffix === "/pdf").expect(200);
        }
        const xmlAllowed = [UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.COMPLIANCE_OFFICER].includes(role);
        await getRaw(`/reports/${f.reportId}/xml?reason=audit`, roleTokens[role]).expect(xmlAllowed ? 200 : 403);
      }
    });

    it("edit/submit/confirm/reject are COMPLIANCE_OFFICER only: the other four roles (SUPER_ADMIN explicitly) get 403 FORBIDDEN_ROLE and nothing changes", async () => {
      const sar = await makeSarReport();
      const ctr = await makeCtrReport();
      const forbidden = [UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.INVESTIGATOR, UserRole.VIEWER];
      for (const id of [sar.reportId, ctr.reportId]) {
        const before = JSON.stringify(await reportRow(id));
        for (const role of forbidden) {
          const t = auth(roleTokens[role]);
          const results = await Promise.all([
            http().patch(`/reports/${id}`).set(t).send({ narrative: "x" }),
            http().patch(`/reports/${id}/submit`).set(t),
            http().patch(`/reports/${id}/confirm`).set(t).send({ nfiuReference: "x" }),
            http().patch(`/reports/${id}/reject`).set(t).send({ reason: "x" }),
          ]);
          for (const res of results) {
            expect(res.status).toBe(403);
            expect(res.body.error.code).toBe("FORBIDDEN_ROLE");
          }
        }
        expect(JSON.stringify(await reportRow(id))).toBe(before);
      }
    });

    it("unauthenticated requests are 401", async () => {
      await http().get("/reports").expect(401);
      await http().patch(`/reports/${crypto.randomUUID()}/confirm`).send({ nfiuReference: "x" }).expect(401);
    });
  });
});
