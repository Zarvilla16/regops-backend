import request from "supertest";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { RiskScoreHistoryEntity } from "@regops/db";
import { ScoreTrigger, UserRole } from "@regops/shared";
import { RescoreSchedulerService } from "../src/risk/scheduler/rescore-scheduler.service";
import {
  closeTestContext,
  createTenantFixture,
  createUserFixture,
  createTestContext,
  seedRiskFactorConfigsFixture,
  seedScreeningProviderConfigsFixture,
  TestContext,
} from "./utils/test-app";

describe("Risk re-scoring (e2e)", () => {
  let ctx: TestContext;
  let tenantId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    tenantId = (await createTenantFixture(ctx.adminDataSource)).id;
    await seedRiskFactorConfigsFixture(ctx.adminDataSource, tenantId);
    // Section 5.1 (Backend Prompt 3): customer creation now runs a
    // synchronous sanctions pre-screen, which requires a configured
    // provider — without this, every createCustomer() call below would
    // 500 (ProviderRegistry: "no primary provider configured").
    await seedScreeningProviderConfigsFixture(ctx.adminDataSource, tenantId);
  });

  afterAll(async () => {
    await closeTestContext(ctx);
  });

  const http = () => request(ctx.app.getHttpServer());

  async function loginAs(email: string, password: string): Promise<string> {
    const res = await http().post("/auth/login").send({ email, password }).expect(200);
    return res.body.data.accessToken;
  }

  async function complianceOfficerToken(emailSuffix: string): Promise<{ token: string; userId: string }> {
    const { user, password } = await createUserFixture(ctx.adminDataSource, tenantId, {
      email: `compliance-${emailSuffix}@test.dev`,
      role: UserRole.COMPLIANCE_OFFICER,
    });
    return { token: await loginAs(user.email, password), userId: user.id };
  }

  async function createCustomer(token: string, overrides: Record<string, unknown> = {}) {
    const res = await http()
      .post("/customers")
      .set("Authorization", `Bearer ${token}`)
      .send({
        cbsCustomerId: `CUST-RESCORE-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        fullName: "Rescore Target",
        customerType: "INDIVIDUAL",
        kycTier: 3,
        onboardedAt: "2024-01-01",
        ...overrides,
      })
      .expect(201);
    return res.body.data;
  }

  it("manual re-score creates a history row with trigger='MANUAL' and calculated_by=current user", async () => {
    const { token, userId } = await complianceOfficerToken("manual-1");
    const customer = await createCustomer(token);

    const res = await http()
      .post(`/customers/${customer.id}/rescore`)
      .set("Authorization", `Bearer ${token}`)
      .expect(201);

    expect(res.body.data.trigger).toBe("MANUAL");
    expect(res.body.data.calculatedBy).toBe(userId);
  });

  it("scheduled re-score (triggered directly here, same as the daily cron would) writes calculated_by=NULL", async () => {
    const { token } = await complianceOfficerToken("scheduled-1");
    // HIGH via PEP override so it's picked up by the "HIGH/CRITICAL" scheduled query.
    const customer = await createCustomer(token, { customerType: "PEP", country: "IR" });

    // Calls the same private per-tenant method the daily @Cron handler uses, scoped to just this
    // test's tenant — calling the public dailyRescoreHighRisk() directly would sweep every ACTIVE
    // tenant in the test database (including ones other e2e files are concurrently creating data
    // in), which would make this test flaky by coupling it to unrelated test files.
    interface SchedulerInternals {
      rescoreTenantCustomers(tenantId: string, riskLevels: string[]): Promise<void>;
    }
    const scheduler = ctx.app.get(RescoreSchedulerService) as unknown as SchedulerInternals;
    await scheduler.rescoreTenantCustomers(tenantId, ["HIGH", "CRITICAL"]);

    const history = await ctx.adminDataSource.getRepository(RiskScoreHistoryEntity).find({
      where: { customerId: customer.id, trigger: ScoreTrigger.SCHEDULED },
    });
    expect(history.length).toBeGreaterThan(0);
    expect(history[0].calculatedBy).toBeNull();
  });

  it("a level transition emits customer.risk_changed", async () => {
    const { token } = await complianceOfficerToken("event-1");
    const customer = await createCustomer(token, { customerType: "INDIVIDUAL", kycTier: 3 }); // LOW

    const eventEmitter = ctx.app.get(EventEmitter2);
    const handler = jest.fn();
    eventEmitter.on("customer.risk_changed", handler);

    try {
      await http()
        .patch(`/customers/${customer.id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ customerType: "PEP", country: "IR" }) // forces CRITICAL via override
        .expect(200);

      expect(handler).toHaveBeenCalledTimes(1);
      const payload = handler.mock.calls[0][0];
      expect(payload.previousLevel).toBe("LOW");
      expect(payload.newLevel).toBe("CRITICAL");
    } finally {
      eventEmitter.off("customer.risk_changed", handler);
    }
  });

  it("no level transition (score changes but level doesn't) does NOT emit customer.risk_changed", async () => {
    const { token } = await complianceOfficerToken("event-2");
    // occupation "Teacher" -> defaultScore 10; INDIVIDUAL(20) + Teacher(10) + NG(0) + kycTier1(30) = 60 -> MEDIUM
    const customer = await createCustomer(token, { customerType: "INDIVIDUAL", kycTier: 1, occupation: "Teacher" });

    const eventEmitter = ctx.app.get(EventEmitter2);
    const handler = jest.fn();
    eventEmitter.on("customer.risk_changed", handler);

    try {
      // occupation change to another non-keyword word: INDIVIDUAL(20) + Nurse(10) + NG(0) + kycTier1(30) = 60 -> still MEDIUM
      await http()
        .patch(`/customers/${customer.id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ occupation: "Nurse" })
        .expect(200);

      expect(handler).not.toHaveBeenCalled();
    } finally {
      eventEmitter.off("customer.risk_changed", handler);
    }
  });

  it("RiskScoreHistory.factors contains a complete breakdown for every calculation", async () => {
    const { token } = await complianceOfficerToken("factors-1");
    const customer = await createCustomer(token, { customerType: "SME", country: "VE", kycTier: 2 });

    const history = await ctx.adminDataSource
      .getRepository(RiskScoreHistoryEntity)
      .findOne({ where: { customerId: customer.id }, order: { calculatedAt: "DESC" } });

    expect(history).not.toBeNull();
    expect(history!.factors).toHaveProperty("CUSTOMER_TYPE");
    expect(history!.factors).toHaveProperty("OCCUPATION");
    expect(history!.factors).toHaveProperty("COUNTRY");
    expect(history!.factors).toHaveProperty("PRODUCT_MIX");
    expect(history!.factors).toHaveProperty("KYC_TIER");
    expect(history!.factors).toHaveProperty("TRANSACTION_VELOCITY");
  });
});
