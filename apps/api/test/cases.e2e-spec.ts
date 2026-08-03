import request from "supertest";
import * as crypto from "crypto";
import { DataSource, QueryRunner } from "typeorm";
import { AlertEntity, CaseAssignmentEventEntity, CustomerEntity, RuleEntity } from "@regops/db";
import { AlertSeverity, CasePriority, CaseStatus, CustomerType, RuleScenarioType, UserRole } from "@regops/shared";
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

  async function createAlert(tenantId: string, customerId: string, severity: AlertSeverity = AlertSeverity.MEDIUM): Promise<AlertEntity> {
    const rule = await ctx.adminDataSource.getRepository(RuleEntity).findOneOrFail({ where: { tenantId, scenarioType: RuleScenarioType.LARGE_CASH } });
    const outcome = await withQr(tenantId, (qr) =>
      alertsService.createOrIncrement(qr, {
        tenantId,
        rule,
        customerId,
        triggeringTransactionId: null,
        severity,
        title: "Cases-test alert",
        evidence: {},
        dedupKey: `cases-test:${crypto.randomUUID()}`,
        firedAt: new Date(),
      }),
    );
    return outcome.alert;
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
});
