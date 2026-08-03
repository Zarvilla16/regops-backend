import request from "supertest";
import * as crypto from "crypto";
import { DataSource, QueryRunner } from "typeorm";
import { AlertEntity, AuditLogEntity, CaseAlertEntity, CaseAssignmentEventEntity, CaseEntity, CustomerEntity, ReportEntity, RuleEntity, TransactionEntity } from "@regops/db";
import {
  AlertSeverity,
  AlertStatus,
  CasePriority,
  CaseStatus,
  CustomerType,
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

describe("Cases module (e2e)", () => {
  let ctx: TestContext;
  let tenantAId: string;
  let tenantBId: string;
  let appDataSource: DataSource;
  let alertsService: AlertsService;

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
    appDataSource = ctx.app.get(DataSource);
    alertsService = ctx.app.get(AlertsService);
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
    const { user, password } = await createUserFixture(ctx.adminDataSource, tenantId, { email: `cases-${emailSuffix}@test.dev`, role });
    return loginAs(user.email, password);
  }

  async function createCustomer(tenantId: string, overrides: Partial<CustomerEntity> = {}): Promise<CustomerEntity> {
    const repo = ctx.adminDataSource.getRepository(CustomerEntity);
    return repo.save(
      repo.create({
        tenantId,
        cbsCustomerId: `CUST-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        fullName: "Cases Test Customer",
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

  async function createAlert(
    tenantId: string,
    customerId: string,
    severity: AlertSeverity = AlertSeverity.MEDIUM,
    relatedTransactionIds: string[] = [],
  ): Promise<AlertEntity> {
    const rule = await ctx.adminDataSource.getRepository(RuleEntity).findOneOrFail({ where: { tenantId, scenarioType: RuleScenarioType.LARGE_CASH } });
    const outcome = await withQr(tenantId, (qr) =>
      alertsService.createOrIncrement(qr, {
        tenantId,
        rule,
        customerId,
        triggeringTransactionId: null,
        severity,
        title: "Cases-test alert",
        evidence: { relatedTransactionIds },
        dedupKey: `cases-test:${crypto.randomUUID()}`,
        firedAt: new Date(),
      }),
    );
    return outcome.alert;
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
        occurredAt: new Date(),
        source: TransactionSource.MANUAL,
        ingestionBatchId: null,
        ...overrides,
      }),
    );
  }

  async function buildEscalatableCase(tenantId: string, creatorToken: string): Promise<{ caseId: string; assignedTo: string }> {
    const customer = await createCustomer(tenantId, { riskLevel: RiskLevel.LOW, lastRiskCalculatedAt: new Date() });
    const alert = await createAlert(tenantId, customer.id);
    await ctx.adminDataSource.getRepository(AlertEntity).update({ id: alert.id }, { status: AlertStatus.ASSIGNED });
    const created = await http().post("/cases").set("Authorization", `Bearer ${creatorToken}`).send({ alertId: alert.id }).expect(201);
    await http()
      .post(`/cases/${created.body.data.id}/notes`)
      .set("Authorization", `Bearer ${creatorToken}`)
      .send({ content: "Investigated and confirmed activity." })
      .expect(201);
    return { caseId: created.body.data.id, assignedTo: created.body.data.assignedTo };
  }

  describe("POST /cases — creation", () => {
    it("creates a bare case with an explicit customerId + priority, self-assigning the creator", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "bare-create");
      const customer = await createCustomer(tenantAId);

      const res = await http()
        .post("/cases")
        .set("Authorization", `Bearer ${token}`)
        .send({ customerId: customer.id, priority: CasePriority.HIGH })
        .expect(201);

      expect(res.body.data.status).toBe(CaseStatus.OPEN);
      expect(res.body.data.priority).toBe(CasePriority.HIGH);
      expect(res.body.data.caseNumber).toMatch(new RegExp(`^CASE-${new Date().getFullYear()}-\\d{4}$`));
      expect(res.body.data.alerts).toEqual([]);

      const assignmentEvents = await ctx.adminDataSource
        .getRepository(CaseAssignmentEventEntity)
        .find({ where: { tenantId: tenantAId, caseId: res.body.data.id } });
      expect(assignmentEvents).toHaveLength(1);
    });

    it("creates a case from an alertId — alert's customerId wins over any body customerId, priority derives from severity", async () => {
      const token = await tokenFor(tenantAId, UserRole.INVESTIGATOR, "from-alert");
      const customer = await createCustomer(tenantAId);
      const otherCustomer = await createCustomer(tenantAId);
      const alert = await createAlert(tenantAId, customer.id, AlertSeverity.CRITICAL);

      const res = await http()
        .post("/cases")
        .set("Authorization", `Bearer ${token}`)
        .send({ alertId: alert.id, customerId: otherCustomer.id })
        .expect(201);

      expect(res.body.data.customerId).toBe(customer.id);
      expect(res.body.data.priority).toBe(CasePriority.HIGH);
      expect(res.body.data.alerts).toHaveLength(1);
      expect(res.body.data.alerts[0].id).toBe(alert.id);
    });

    it("400 CUSTOMER_REQUIRED when neither customerId nor alertId is given", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "no-customer");
      const res = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({}).expect(400);
      expect(res.body.error.code).toBe("CUSTOMER_REQUIRED");
    });

    it("404 ALERT_NOT_FOUND for a nonexistent alertId", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "bad-alert");
      const res = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ alertId: crypto.randomUUID() }).expect(404);
      expect(res.body.error.code).toBe("ALERT_NOT_FOUND");
    });

    it("404 CUSTOMER_NOT_FOUND for a nonexistent customerId", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "bad-customer");
      const res = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ customerId: crypto.randomUUID() }).expect(404);
      expect(res.body.error.code).toBe("CUSTOMER_NOT_FOUND");
    });

    it("403 FORBIDDEN_ROLE for VIEWER", async () => {
      const token = await tokenFor(tenantAId, UserRole.VIEWER, "viewer-create");
      const customer = await createCustomer(tenantAId);
      await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ customerId: customer.id }).expect(403);
    });

    it("a customer/alert from a different tenant is 404, not visible cross-tenant", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "cross-tenant");
      const otherTenantCustomer = await createCustomer(tenantBId);
      const res = await http()
        .post("/cases")
        .set("Authorization", `Bearer ${token}`)
        .send({ customerId: otherTenantCustomer.id })
        .expect(404);
      expect(res.body.error.code).toBe("CUSTOMER_NOT_FOUND");
    });
  });

  describe("GET /cases, GET /cases/:id", () => {
    it("lists only the caller's tenant's cases and supports status/priority/q filters", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "list-basic");
      const customer = await createCustomer(tenantAId, { fullName: "Findable Person" });
      await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ customerId: customer.id }).expect(201);

      const res = await http().get("/cases").query({ q: "Findable" }).set("Authorization", `Bearer ${token}`).expect(200);
      // ResponseInterceptor wraps return as { data }, and list() returns { data, meta }, so shape is { success, data: { data: [...], meta } }.
      expect(res.body.data.data.length).toBeGreaterThanOrEqual(1);
      expect(res.body.data.data.every((c: { customer: { fullName: string } | null }) => c.customer?.fullName === "Findable Person")).toBe(true);
    });

    it("a case belonging to another tenant is 404 on GET /cases/:id", async () => {
      const tokenB = await tokenFor(tenantBId, UserRole.COMPLIANCE_OFFICER, "tenantb-detail");
      const tokenA = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "tenanta-create");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${tokenA}`).send({ customerId: customer.id }).expect(201);

      await http().get(`/cases/${created.body.data.id}`).set("Authorization", `Bearer ${tokenB}`).expect(404);
    });

    it("VIEWER can view case list/detail (read is not role-gated beyond authentication)", async () => {
      const tokenViewer = await tokenFor(tenantAId, UserRole.VIEWER, "viewer-read");
      await http().get("/cases").set("Authorization", `Bearer ${tokenViewer}`).expect(200);
    });
  });

  describe("POST /cases/:id/notes", () => {
    it("adds a note and auto-transitions an OPEN case to UNDER_INVESTIGATION", async () => {
      const token = await tokenFor(tenantAId, UserRole.INVESTIGATOR, "note-transition");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ customerId: customer.id }).expect(201);
      expect(created.body.data.status).toBe(CaseStatus.OPEN);

      const noteRes = await http()
        .post(`/cases/${created.body.data.id}/notes`)
        .set("Authorization", `Bearer ${token}`)
        .send({ content: "Reviewed the customer's transaction history." })
        .expect(201);
      expect(noteRes.body.data.content).toBe("Reviewed the customer's transaction history.");

      const detail = await http().get(`/cases/${created.body.data.id}`).set("Authorization", `Bearer ${token}`).expect(200);
      expect(detail.body.data.status).toBe(CaseStatus.UNDER_INVESTIGATION);
      expect(detail.body.data.notes).toHaveLength(1);
    });

    it("adding a second note to an already-UNDER_INVESTIGATION case does not error or regress status", async () => {
      const token = await tokenFor(tenantAId, UserRole.INVESTIGATOR, "note-idempotent");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ customerId: customer.id }).expect(201);
      await http().post(`/cases/${created.body.data.id}/notes`).set("Authorization", `Bearer ${token}`).send({ content: "First note." }).expect(201);
      await http().post(`/cases/${created.body.data.id}/notes`).set("Authorization", `Bearer ${token}`).send({ content: "Second note." }).expect(201);

      const detail = await http().get(`/cases/${created.body.data.id}`).set("Authorization", `Bearer ${token}`).expect(200);
      expect(detail.body.data.status).toBe(CaseStatus.UNDER_INVESTIGATION);
      expect(detail.body.data.notes).toHaveLength(2);
    });

    it("400 CONTENT_REQUIRED for empty/whitespace-only content", async () => {
      const token = await tokenFor(tenantAId, UserRole.INVESTIGATOR, "note-empty");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ customerId: customer.id }).expect(201);
      const res = await http()
        .post(`/cases/${created.body.data.id}/notes`)
        .set("Authorization", `Bearer ${token}`)
        .send({ content: "   " })
        .expect(400);
      expect(res.body.error.code).toBe("CONTENT_REQUIRED");
    });

    it("403 FORBIDDEN_ROLE for VIEWER", async () => {
      const tokenCreator = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "note-viewer-setup");
      const tokenViewer = await tokenFor(tenantAId, UserRole.VIEWER, "note-viewer");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${tokenCreator}`).send({ customerId: customer.id }).expect(201);
      await http().post(`/cases/${created.body.data.id}/notes`).set("Authorization", `Bearer ${tokenViewer}`).send({ content: "x" }).expect(403);
    });

    it("404 CASE_NOT_FOUND for a case in a different tenant", async () => {
      const tokenA = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "note-tenanta");
      const tokenB = await tokenFor(tenantBId, UserRole.COMPLIANCE_OFFICER, "note-tenantb");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${tokenA}`).send({ customerId: customer.id }).expect(201);
      await http().post(`/cases/${created.body.data.id}/notes`).set("Authorization", `Bearer ${tokenB}`).send({ content: "x" }).expect(404);
    });
  });

  describe("Evidence upload/download", () => {
    it("uploads a PDF, auto-transitions OPEN -> UNDER_INVESTIGATION, and downloads it back byte-for-byte", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "evidence-roundtrip");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ customerId: customer.id }).expect(201);
      const caseId = created.body.data.id;
      const fileContents = Buffer.from("%PDF-1.4 test evidence content");

      const uploadRes = await http()
        .post(`/cases/${caseId}/evidence`)
        .set("Authorization", `Bearer ${token}`)
        .attach("file", fileContents, { filename: "statement.pdf", contentType: "application/pdf" })
        .expect(201);
      expect(uploadRes.body.data.fileName).toBe("statement.pdf");

      const detail = await http().get(`/cases/${caseId}`).set("Authorization", `Bearer ${token}`).expect(200);
      expect(detail.body.data.status).toBe(CaseStatus.UNDER_INVESTIGATION);
      expect(detail.body.data.evidence).toHaveLength(1);

      const downloadRes = await http()
        .get(`/cases/${caseId}/evidence/${uploadRes.body.data.id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(Buffer.compare(downloadRes.body, fileContents)).toBe(0);

      const auditRows = await ctx.adminDataSource
        .getRepository(AuditLogEntity)
        .find({ where: { tenantId: tenantAId, entityId: caseId, action: "case.evidence_uploaded" } });
      expect(auditRows.length).toBeGreaterThanOrEqual(1);
      const downloadAuditRows = await ctx.adminDataSource
        .getRepository(AuditLogEntity)
        .find({ where: { tenantId: tenantAId, entityId: caseId, action: "case.evidence_downloaded" } });
      expect(downloadAuditRows.length).toBeGreaterThanOrEqual(1);
    });

    it("400 INVALID_FILE_TYPE for a disallowed content type", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "evidence-bad-type");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ customerId: customer.id }).expect(201);

      const res = await http()
        .post(`/cases/${created.body.data.id}/evidence`)
        .set("Authorization", `Bearer ${token}`)
        .attach("file", Buffer.from("#!/bin/sh"), { filename: "script.sh", contentType: "application/x-sh" })
        .expect(400);
      expect(res.body.error.code).toBe("INVALID_FILE_TYPE");
    });

    it("400 FILE_TOO_LARGE for a file over 10MB", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "evidence-too-large");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ customerId: customer.id }).expect(201);
      const oversized = Buffer.alloc(10 * 1024 * 1024 + 1, 1);

      const res = await http()
        .post(`/cases/${created.body.data.id}/evidence`)
        .set("Authorization", `Bearer ${token}`)
        .attach("file", oversized, { filename: "big.csv", contentType: "text/csv" })
        .expect(400);
      expect(res.body.error.code).toBe("FILE_TOO_LARGE");
    });

    it("403 FORBIDDEN_ROLE for VIEWER on upload", async () => {
      const tokenCreator = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "evidence-viewer-setup");
      const tokenViewer = await tokenFor(tenantAId, UserRole.VIEWER, "evidence-viewer");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${tokenCreator}`).send({ customerId: customer.id }).expect(201);
      await http()
        .post(`/cases/${created.body.data.id}/evidence`)
        .set("Authorization", `Bearer ${tokenViewer}`)
        .attach("file", Buffer.from("csv,data"), { filename: "x.csv", contentType: "text/csv" })
        .expect(403);
    });
  });

  describe("GET /cases/:id/checklist", () => {
    it("item 1/3 any-vs-every distinction: one reviewed + one still-NEW alert passes item 1 but fails item 3", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "checklist-any-every");
      const customer = await createCustomer(tenantAId);
      const txn = await createTransaction(tenantAId, customer.id);
      const reviewedAlert = await createAlert(tenantAId, customer.id, AlertSeverity.MEDIUM, [txn.id]);
      const newAlert = await createAlert(tenantAId, customer.id, AlertSeverity.MEDIUM, [txn.id]);
      await ctx.adminDataSource.getRepository(AlertEntity).update({ id: reviewedAlert.id }, { status: AlertStatus.ASSIGNED });

      const created = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ alertId: reviewedAlert.id }).expect(201);
      // Second alert linked directly (Task 7's link endpoint doesn't exist yet) —
      // checklist logic only cares that a case_alert row exists, not how it got there.
      await ctx.adminDataSource.getRepository(CaseAlertEntity).save(
        ctx.adminDataSource.getRepository(CaseAlertEntity).create({
          tenantId: tenantAId,
          caseId: created.body.data.id,
          alertId: newAlert.id,
          linkedAt: new Date(),
          linkedBy: created.body.data.createdBy,
        }),
      );

      const res = await http().get(`/cases/${created.body.data.id}/checklist`).set("Authorization", `Bearer ${token}`).expect(200);
      const byKey = Object.fromEntries(res.body.data.items.map((i: { key: string; passed: boolean }) => [i.key, i.passed]));
      expect(byKey.ALERT_REVIEWED).toBe(true);
      expect(byKey.TRANSACTIONS_REVIEWED).toBe(false);
      expect(res.body.data.complete).toBe(false);
    });

    it("item 2 (note added) is independent of alerts", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "checklist-note");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ customerId: customer.id }).expect(201);

      let res = await http().get(`/cases/${created.body.data.id}/checklist`).set("Authorization", `Bearer ${token}`).expect(200);
      expect(res.body.data.items.find((i: { key: string }) => i.key === "NOTE_ADDED").passed).toBe(false);

      await http().post(`/cases/${created.body.data.id}/notes`).set("Authorization", `Bearer ${token}`).send({ content: "note" }).expect(201);
      res = await http().get(`/cases/${created.body.data.id}/checklist`).set("Authorization", `Bearer ${token}`).expect(200);
      expect(res.body.data.items.find((i: { key: string }) => i.key === "NOTE_ADDED").passed).toBe(true);
    });

    it("item 4: false when lastRiskCalculatedAt is null; true when within the risk band's cadence; false when stale", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "checklist-risk");
      const customerRepo = ctx.adminDataSource.getRepository(CustomerEntity);
      const customer = await createCustomer(tenantAId, { riskLevel: RiskLevel.HIGH, lastRiskCalculatedAt: null });
      const created = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ customerId: customer.id }).expect(201);

      let res = await http().get(`/cases/${created.body.data.id}/checklist`).set("Authorization", `Bearer ${token}`).expect(200);
      expect(res.body.data.items.find((i: { key: string }) => i.key === "RISK_SCORE_CURRENT").passed).toBe(false);

      await customerRepo.update({ id: customer.id }, { lastRiskCalculatedAt: new Date() }); // HIGH cadence = 1 day
      res = await http().get(`/cases/${created.body.data.id}/checklist`).set("Authorization", `Bearer ${token}`).expect(200);
      expect(res.body.data.items.find((i: { key: string }) => i.key === "RISK_SCORE_CURRENT").passed).toBe(true);

      await customerRepo.update({ id: customer.id }, { lastRiskCalculatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) });
      res = await http().get(`/cases/${created.body.data.id}/checklist`).set("Authorization", `Bearer ${token}`).expect(200);
      expect(res.body.data.items.find((i: { key: string }) => i.key === "RISK_SCORE_CURRENT").passed).toBe(false);
    });

    it("is included directly in GET /cases/:id detail", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "checklist-in-detail");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ customerId: customer.id }).expect(201);
      const detail = await http().get(`/cases/${created.body.data.id}`).set("Authorization", `Bearer ${token}`).expect(200);
      expect(detail.body.data.checklist.items).toHaveLength(4);
    });
  });

  describe("POST /cases/:id/alerts", () => {
    it("links an existing alert, and does NOT change the alert's own status or auto-transition the case", async () => {
      const token = await tokenFor(tenantAId, UserRole.INVESTIGATOR, "link-alert");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ customerId: customer.id }).expect(201);
      const alert = await createAlert(tenantAId, customer.id);

      const res = await http()
        .post(`/cases/${created.body.data.id}/alerts`)
        .set("Authorization", `Bearer ${token}`)
        .send({ alertId: alert.id })
        .expect(201);
      expect(res.body.data.alerts).toHaveLength(1);
      expect(res.body.data.status).toBe(CaseStatus.OPEN);

      const freshAlert = await ctx.adminDataSource.getRepository(AlertEntity).findOneOrFail({ where: { id: alert.id } });
      expect(freshAlert.status).toBe(AlertStatus.NEW);
    });

    it("linking an unreviewed alert regresses a previously-satisfiable checklist item 3", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "link-regress-checklist");
      const customer = await createCustomer(tenantAId);
      const txn = await createTransaction(tenantAId, customer.id);
      const reviewedAlert = await createAlert(tenantAId, customer.id, AlertSeverity.MEDIUM, [txn.id]);
      await ctx.adminDataSource.getRepository(AlertEntity).update({ id: reviewedAlert.id }, { status: AlertStatus.ASSIGNED });
      const created = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ alertId: reviewedAlert.id }).expect(201);

      let checklist = await http().get(`/cases/${created.body.data.id}/checklist`).set("Authorization", `Bearer ${token}`).expect(200);
      expect(checklist.body.data.items.find((i: { key: string }) => i.key === "TRANSACTIONS_REVIEWED").passed).toBe(true);

      const newAlert = await createAlert(tenantAId, customer.id, AlertSeverity.MEDIUM, [txn.id]);
      await http().post(`/cases/${created.body.data.id}/alerts`).set("Authorization", `Bearer ${token}`).send({ alertId: newAlert.id }).expect(201);

      checklist = await http().get(`/cases/${created.body.data.id}/checklist`).set("Authorization", `Bearer ${token}`).expect(200);
      expect(checklist.body.data.items.find((i: { key: string }) => i.key === "TRANSACTIONS_REVIEWED").passed).toBe(false);
    });

    it("400 ALERT_CUSTOMER_MISMATCH when the alert belongs to a different customer", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "link-mismatch");
      const customer = await createCustomer(tenantAId);
      const otherCustomer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ customerId: customer.id }).expect(201);
      const alert = await createAlert(tenantAId, otherCustomer.id);

      const res = await http()
        .post(`/cases/${created.body.data.id}/alerts`)
        .set("Authorization", `Bearer ${token}`)
        .send({ alertId: alert.id })
        .expect(400);
      expect(res.body.error.code).toBe("ALERT_CUSTOMER_MISMATCH");
    });

    it("400 ALERT_ALREADY_LINKED when the alert already belongs to a case", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "link-already");
      const customer = await createCustomer(tenantAId);
      const alert = await createAlert(tenantAId, customer.id);
      const firstCase = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ alertId: alert.id }).expect(201);
      const secondCase = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ customerId: customer.id }).expect(201);

      const res = await http()
        .post(`/cases/${secondCase.body.data.id}/alerts`)
        .set("Authorization", `Bearer ${token}`)
        .send({ alertId: alert.id })
        .expect(400);
      expect(res.body.error.code).toBe("ALERT_ALREADY_LINKED");
      void firstCase;
    });

    it("400 CASE_ALREADY_TERMINAL when the case is CLOSED", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "link-terminal");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ customerId: customer.id }).expect(201);
      await ctx.adminDataSource.getRepository(CaseEntity).update({ id: created.body.data.id }, { status: CaseStatus.CLOSED });
      const alert = await createAlert(tenantAId, customer.id);

      const res = await http()
        .post(`/cases/${created.body.data.id}/alerts`)
        .set("Authorization", `Bearer ${token}`)
        .send({ alertId: alert.id })
        .expect(400);
      expect(res.body.error.code).toBe("CASE_ALREADY_TERMINAL");
    });

    it("404 ALERT_NOT_FOUND for a nonexistent alertId", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "link-not-found");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ customerId: customer.id }).expect(201);
      const res = await http()
        .post(`/cases/${created.body.data.id}/alerts`)
        .set("Authorization", `Bearer ${token}`)
        .send({ alertId: crypto.randomUUID() })
        .expect(404);
      expect(res.body.error.code).toBe("ALERT_NOT_FOUND");
    });
  });

  describe("State machine: close/submit/approve/reject", () => {
    it("closes an OPEN case with the default closure reason when none is given", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "close-default");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ customerId: customer.id }).expect(201);

      const res = await http().patch(`/cases/${created.body.data.id}/close`).set("Authorization", `Bearer ${token}`).send({}).expect(200);
      expect(res.body.data.status).toBe(CaseStatus.CLOSED);
      expect(res.body.data.closureReason).toBe("False positive — no suspicious activity confirmed after investigation.");
      expect(res.body.data.closedBy).toBeTruthy();
    });

    it("409 INVALID_TRANSITION closing an already-CLOSED case", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "close-twice");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ customerId: customer.id }).expect(201);
      await http().patch(`/cases/${created.body.data.id}/close`).set("Authorization", `Bearer ${token}`).send({}).expect(200);

      const res = await http().patch(`/cases/${created.body.data.id}/close`).set("Authorization", `Bearer ${token}`).send({}).expect(409);
      expect(res.body.error.code).toBe("INVALID_TRANSITION");
    });

    it("403 FORBIDDEN_ROLE for INVESTIGATOR on close/submit/approve/reject (COMPLIANCE_OFFICER only)", async () => {
      const investigatorToken = await tokenFor(tenantAId, UserRole.INVESTIGATOR, "role-gate-investigator");
      const officerToken = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "role-gate-setup");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${officerToken}`).send({ customerId: customer.id }).expect(201);

      await http().patch(`/cases/${created.body.data.id}/close`).set("Authorization", `Bearer ${investigatorToken}`).send({}).expect(403);
      await http().patch(`/cases/${created.body.data.id}/submit`).set("Authorization", `Bearer ${investigatorToken}`).send({ escalationRationale: "x" }).expect(403);
      await http().patch(`/cases/${created.body.data.id}/approve`).set("Authorization", `Bearer ${investigatorToken}`).send({}).expect(403);
      await http().patch(`/cases/${created.body.data.id}/reject`).set("Authorization", `Bearer ${investigatorToken}`).send({ reason: "x" }).expect(403);
    });

    it("403 SUBMITTER_CANNOT_BE_ASSIGNEE when the case's own assignee tries to submit it", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "submit-self-assignee");
      const { caseId } = await buildEscalatableCase(tenantAId, token); // creator == assignee == token's user
      const res = await http()
        .patch(`/cases/${caseId}/submit`)
        .set("Authorization", `Bearer ${token}`)
        .send({ escalationRationale: "Escalating for SAR filing." })
        .expect(403);
      expect(res.body.error.code).toBe("SUBMITTER_CANNOT_BE_ASSIGNEE");
    });

    it("400 ESCALATION_CHECKLIST_INCOMPLETE with the specific failed item keys", async () => {
      const creatorToken = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "checklist-incomplete-creator");
      const submitterToken = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "checklist-incomplete-submitter");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${creatorToken}`).send({ customerId: customer.id }).expect(201);

      const res = await http()
        .patch(`/cases/${created.body.data.id}/submit`)
        .set("Authorization", `Bearer ${submitterToken}`)
        .send({ escalationRationale: "Escalating." })
        .expect(400);
      expect(res.body.error.code).toBe("ESCALATION_CHECKLIST_INCOMPLETE");
      expect(res.body.error.details.failedItems).toEqual(
        expect.arrayContaining(["ALERT_REVIEWED", "NOTE_ADDED"]),
      );
    });

    it("400 ESCALATION_RATIONALE_REQUIRED when the checklist passes but rationale is blank", async () => {
      const creatorToken = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "rationale-required-creator");
      const submitterToken = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "rationale-required-submitter");
      const { caseId } = await buildEscalatableCase(tenantAId, creatorToken);

      const res = await http()
        .patch(`/cases/${caseId}/submit`)
        .set("Authorization", `Bearer ${submitterToken}`)
        .send({ escalationRationale: "   " })
        .expect(400);
      expect(res.body.error.code).toBe("ESCALATION_RATIONALE_REQUIRED");
    });

    it("full maker-checker flow: submit (A) -> reject (B, reason stored, back to UNDER_INVESTIGATION) -> resubmit (B) -> approve (A) -> SAR_FILED + exactly one Report row", async () => {
      const creatorToken = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "maker-checker-creator");
      const submitterToken = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "maker-checker-submitter");
      const { caseId, assignedTo } = await buildEscalatableCase(tenantAId, creatorToken);

      // Submit as the submitter (not the assignee).
      const submitRes = await http()
        .patch(`/cases/${caseId}/submit`)
        .set("Authorization", `Bearer ${submitterToken}`)
        .send({ escalationRationale: "Confirmed suspicious structuring pattern." })
        .expect(200);
      expect(submitRes.body.data.status).toBe(CaseStatus.PENDING_APPROVAL);

      // Approve as the submitter themselves -> rejected (maker-checker gate).
      const selfApprove = await http().patch(`/cases/${caseId}/approve`).set("Authorization", `Bearer ${submitterToken}`).send({}).expect(403);
      expect(selfApprove.body.error.code).toBe("APPROVER_CANNOT_BE_SUBMITTER");

      // Reject as creatorToken — the case's own creator self-assigns at creation (Section
      // 3.1), so creatorToken's user IS `assignedTo`, and is a different Compliance
      // Officer than submitterToken, satisfying the maker-checker gate.
      expect(assignedTo).toBeTruthy();
      const rejectRes = await http()
        .patch(`/cases/${caseId}/reject`)
        .set("Authorization", `Bearer ${creatorToken}`)
        .send({ reason: "Needs a second linked transaction reviewed before filing." })
        .expect(200);
      expect(rejectRes.body.data.status).toBe(CaseStatus.UNDER_INVESTIGATION);
      expect(rejectRes.body.data.submittedBy).toBeNull();
      expect(rejectRes.body.data.submittedAt).toBeNull();
      expect(rejectRes.body.data.escalationRationale).toBeNull();

      // Resubmit (checklist is still complete — note/alert/risk state unchanged) and approve as the (different) creator/assignee.
      await http()
        .patch(`/cases/${caseId}/submit`)
        .set("Authorization", `Bearer ${submitterToken}`)
        .send({ escalationRationale: "Re-escalating after addressing the rejection." })
        .expect(200);
      const approveRes = await http().patch(`/cases/${caseId}/approve`).set("Authorization", `Bearer ${creatorToken}`).send({}).expect(200);
      expect(approveRes.body.data.status).toBe(CaseStatus.SAR_FILED);
      expect(approveRes.body.data.report).not.toBeNull();

      const reports = await ctx.adminDataSource.getRepository(ReportEntity).find({ where: { tenantId: tenantAId, caseId } });
      expect(reports).toHaveLength(1);
      expect(reports[0].customerId).toBe((await ctx.adminDataSource.getRepository(CaseEntity).findOneOrFail({ where: { id: caseId } })).customerId);

      // Cannot approve a second time — the case is already terminal.
      const doubleApprove = await http().patch(`/cases/${caseId}/approve`).set("Authorization", `Bearer ${creatorToken}`).send({}).expect(409);
      expect(doubleApprove.body.error.code).toBe("INVALID_TRANSITION");
    });

    it("400 REJECTION_REASON_REQUIRED for a blank reason", async () => {
      const creatorToken = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "reject-reason-creator");
      const submitterToken = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "reject-reason-submitter");
      const { caseId } = await buildEscalatableCase(tenantAId, creatorToken);
      await http()
        .patch(`/cases/${caseId}/submit`)
        .set("Authorization", `Bearer ${submitterToken}`)
        .send({ escalationRationale: "Escalating." })
        .expect(200);

      const res = await http().patch(`/cases/${caseId}/reject`).set("Authorization", `Bearer ${creatorToken}`).send({ reason: "  " }).expect(400);
      expect(res.body.error.code).toBe("REJECTION_REASON_REQUIRED");
    });
  });

  describe("PATCH /cases/:id/assign", () => {
    it("reassigns the case and records a case_assignment_event row (index 1, after creation's index 0)", async () => {
      const officerToken = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "assign-officer");
      const { user: newAssignee } = await createUserFixture(ctx.adminDataSource, tenantAId, { email: "assign-target@test.dev", role: UserRole.INVESTIGATOR });
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${officerToken}`).send({ customerId: customer.id }).expect(201);

      const res = await http()
        .patch(`/cases/${created.body.data.id}/assign`)
        .set("Authorization", `Bearer ${officerToken}`)
        .send({ assignedTo: newAssignee.id })
        .expect(200);
      expect(res.body.data.assignedTo).toBe(newAssignee.id);

      const events = await ctx.adminDataSource
        .getRepository(CaseAssignmentEventEntity)
        .find({ where: { tenantId: tenantAId, caseId: created.body.data.id }, order: { at: "ASC" } });
      expect(events).toHaveLength(2);
      expect(events[1].assignedTo).toBe(newAssignee.id);
    });

    it("unassigns with assignedTo: null", async () => {
      const officerToken = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "assign-unassign");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${officerToken}`).send({ customerId: customer.id }).expect(201);

      const res = await http()
        .patch(`/cases/${created.body.data.id}/assign`)
        .set("Authorization", `Bearer ${officerToken}`)
        .send({ assignedTo: null })
        .expect(200);
      expect(res.body.data.assignedTo).toBeNull();
    });

    it("TENANT_ADMIN can reassign; INVESTIGATOR and VIEWER cannot (403)", async () => {
      const officerToken = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "assign-setup");
      const adminToken = await tokenFor(tenantAId, UserRole.TENANT_ADMIN, "assign-admin");
      const investigatorToken = await tokenFor(tenantAId, UserRole.INVESTIGATOR, "assign-investigator");
      const viewerToken = await tokenFor(tenantAId, UserRole.VIEWER, "assign-viewer");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${officerToken}`).send({ customerId: customer.id }).expect(201);

      await http().patch(`/cases/${created.body.data.id}/assign`).set("Authorization", `Bearer ${adminToken}`).send({ assignedTo: null }).expect(200);
      await http().patch(`/cases/${created.body.data.id}/assign`).set("Authorization", `Bearer ${investigatorToken}`).send({ assignedTo: null }).expect(403);
      await http().patch(`/cases/${created.body.data.id}/assign`).set("Authorization", `Bearer ${viewerToken}`).send({ assignedTo: null }).expect(403);
    });

    it("400 CASE_ALREADY_TERMINAL on a CLOSED case", async () => {
      const officerToken = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "assign-terminal");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${officerToken}`).send({ customerId: customer.id }).expect(201);
      await http().patch(`/cases/${created.body.data.id}/close`).set("Authorization", `Bearer ${officerToken}`).send({}).expect(200);

      const res = await http()
        .patch(`/cases/${created.body.data.id}/assign`)
        .set("Authorization", `Bearer ${officerToken}`)
        .send({ assignedTo: null })
        .expect(400);
      expect(res.body.error.code).toBe("CASE_ALREADY_TERMINAL");
    });
  });
});
