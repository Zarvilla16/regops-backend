import request from "supertest";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { Queue } from "bullmq";
import { CustomerEntity, ScreeningCheckEntity, ScreeningMatchEntity, ScreeningProviderConfigEntity } from "@regops/db";
import { ASYNC_SCREENING_QUEUE, ScreeningCheckType, ScreeningProviderName, UserRole } from "@regops/shared";
import {
  closeTestContext,
  createTenantFixture,
  createUserFixture,
  createTestContext,
  seedRiskFactorConfigsFixture,
  seedScreeningProviderConfigsFixture,
  TestContext,
} from "./utils/test-app";

function parseRedisUrl(url: string) {
  const parsed = new URL(url);
  return { host: parsed.hostname, port: Number(parsed.port || 6379), password: parsed.password || undefined, maxRetriesPerRequest: null as null };
}

describe("Screening (e2e)", () => {
  let ctx: TestContext;
  let tenantAId: string;
  let tenantBId: string;
  let asyncQueue: Queue;

  beforeAll(async () => {
    ctx = await createTestContext();
    tenantAId = (await createTenantFixture(ctx.adminDataSource)).id;
    tenantBId = (await createTenantFixture(ctx.adminDataSource)).id;
    await seedRiskFactorConfigsFixture(ctx.adminDataSource, tenantAId);
    await seedRiskFactorConfigsFixture(ctx.adminDataSource, tenantBId);
    await seedScreeningProviderConfigsFixture(ctx.adminDataSource, tenantAId);
    await seedScreeningProviderConfigsFixture(ctx.adminDataSource, tenantBId);

    asyncQueue = new Queue(ASYNC_SCREENING_QUEUE, { connection: parseRedisUrl(process.env.REDIS_URL!) });
  });

  afterAll(async () => {
    await asyncQueue.close();
    await closeTestContext(ctx);
  });

  const http = () => request(ctx.app.getHttpServer());

  async function loginAs(email: string, password: string): Promise<string> {
    const res = await http().post("/auth/login").send({ email, password }).expect(200);
    return res.body.data.accessToken;
  }

  // createUserFixture appends a random nonce to whatever email is passed in (see
  // its own docblock / HANDOFF.md bug #16) — no local workaround needed here
  // anymore; emailSuffix below is just for readability in failure traces.
  async function tenantAdminToken(tenantId: string, emailSuffix: string): Promise<string> {
    const { user, password } = await createUserFixture(ctx.adminDataSource, tenantId, {
      email: `admin-scr-${emailSuffix}@test.dev`,
      role: UserRole.TENANT_ADMIN,
    });
    return loginAs(user.email, password);
  }

  async function complianceToken(tenantId: string, emailSuffix: string): Promise<string> {
    const { user, password } = await createUserFixture(ctx.adminDataSource, tenantId, {
      email: `compliance-scr-${emailSuffix}@test.dev`,
      role: UserRole.COMPLIANCE_OFFICER,
    });
    return loginAs(user.email, password);
  }

  function createCustomerBody(overrides: Record<string, unknown> = {}) {
    return {
      cbsCustomerId: `CUST-SCR-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      fullName: "Ordinary Customer",
      customerType: "INDIVIDUAL",
      kycTier: 1,
      onboardedAt: "2024-01-01",
      ...overrides,
    };
  }

  // --- Section 10.3: synchronous sanctions block ----------------------------
  describe("synchronous sanctions block at onboarding", () => {
    it("blocks a confirmed sanctions match with 422, creates no Customer row, and leaves a full audit trail", async () => {
      const token = await tenantAdminToken(tenantAId, "sync-1");
      const countBefore = await ctx.adminDataSource.getRepository(CustomerEntity).count({ where: { tenantId: tenantAId } });

      const res = await http()
        .post("/customers")
        .set("Authorization", `Bearer ${token}`)
        .send(createCustomerBody({ fullName: "John SANCTIONED Doe" }))
        .expect(422);

      expect(res.body.error.code).toBe("SANCTIONS_MATCH_BLOCK");
      expect(res.body.error.details).not.toHaveProperty("listSource");
      expect(res.body.error.details).not.toHaveProperty("matchName");

      const countAfter = await ctx.adminDataSource.getRepository(CustomerEntity).count({ where: { tenantId: tenantAId } });
      expect(countAfter).toBe(countBefore);

      const checkId = res.body.error.details.screeningCheckId;
      const check = await ctx.adminDataSource.getRepository(ScreeningCheckEntity).findOne({ where: { id: checkId } });
      expect(check).toBeTruthy();
      expect(check!.status).toBe("COMPLETED");
      expect(check!.result).toBe("CONFIRMED_MATCH");
      expect(check!.customerId).toBeNull();
      expect(check!.checkType).toBe("SANCTIONS");

      const matches = await ctx.adminDataSource.getRepository(ScreeningMatchEntity).find({ where: { screeningCheckId: checkId } });
      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].reviewStatus).toBe("PENDING_REVIEW");
      expect(matches[0].customerId).toBeNull(); // the DB entity — confirms the row itself, not the API's serialization of it.

      // The API response is a separate concern from the DB row: toMatchDto
      // once coerced a null customerId to "" (an invalid, misleading
      // empty-string stand-in for "no customer"), which this specifically
      // catches by going through the real endpoint rather than re-checking
      // the entity a second time.
      const matchDetail = await http()
        .get(`/screening/matches/${matches[0].id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(matchDetail.body.data.customerId).toBeNull();

      const matchList = await http()
        .get("/screening/matches")
        .query({ review_status: "PENDING_REVIEW" })
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      const listedMatch = matchList.body.data.data.find((m: { id: string }) => m.id === matches[0].id);
      expect(listedMatch.customerId).toBeNull();

      const auditRows = await ctx.adminDataSource.query(
        `SELECT * FROM audit_log WHERE tenant_id = $1 AND action = 'customer.create.blocked' ORDER BY created_at DESC LIMIT 1`,
        [tenantAId],
      );
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0].after_state.screeningCheckId).toBe(checkId);

      // Section 12's Definition of Done: screening.check.completed must also
      // be a real audit_log action, not just an in-process event.
      const checkCompletedAudit = await ctx.adminDataSource.query(
        `SELECT * FROM audit_log WHERE tenant_id = $1 AND action = 'screening.check.completed' AND entity_id = $2`,
        [tenantAId, checkId],
      );
      expect(checkCompletedAudit).toHaveLength(1);
    });

    it("creates the customer and enqueues an async PEP/adverse-media job for a clean name", async () => {
      const token = await tenantAdminToken(tenantAId, "sync-2");
      const beforeCounts = await asyncQueue.getJobCounts();

      const res = await http()
        .post("/customers")
        .set("Authorization", `Bearer ${token}`)
        .send(createCustomerBody({ fullName: "Perfectly Clean Person" }))
        .expect(201);

      expect(res.body.data.id).toBeTruthy();

      // Give BullMQ's local add() a moment to register — no worker consumes
      // this queue during API e2e tests, so the job sits in "waiting".
      await new Promise((resolve) => setTimeout(resolve, 200));
      const afterCounts = await asyncQueue.getJobCounts();
      expect((afterCounts.waiting ?? 0) + (afterCounts.active ?? 0)).toBeGreaterThan((beforeCounts.waiting ?? 0) + (beforeCounts.active ?? 0) - 1);
    });

    it("does not block on a POTENTIAL_MATCH — creates the customer normally", async () => {
      const token = await tenantAdminToken(tenantAId, "sync-3");

      const res = await http()
        .post("/customers")
        .set("Authorization", `Bearer ${token}`)
        .send(createCustomerBody({ fullName: "Maybe POSSIBLY_SANCTIONED Person" }))
        .expect(201);

      expect(res.body.data.id).toBeTruthy();

      const checks = await ctx.adminDataSource.getRepository(ScreeningCheckEntity).find({ where: { customerId: res.body.data.id } });
      expect(checks.some((c) => c.result === "POTENTIAL_MATCH")).toBe(true);
    });
  });

  // --- Remaining Section 6 endpoints not otherwise exercised above -----------
  describe("checks + on-demand sanctions endpoints", () => {
    it("GET /screening/checks and GET /screening/checks/:id return what the sync block just wrote", async () => {
      const token = await tenantAdminToken(tenantAId, "checks-1");

      const blocked = await http()
        .post("/customers")
        .set("Authorization", `Bearer ${token}`)
        .send(createCustomerBody({ fullName: "Checks Endpoint SANCTIONED Person" }))
        .expect(422);
      const checkId = blocked.body.error.details.screeningCheckId;

      const list = await http()
        .get("/screening/checks")
        .query({ check_type: "SANCTIONS", result: "CONFIRMED_MATCH" })
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(list.body.data.data.some((c: { id: string }) => c.id === checkId)).toBe(true);

      const detail = await http().get(`/screening/checks/${checkId}`).set("Authorization", `Bearer ${token}`).expect(200);
      expect(detail.body.data.id).toBe(checkId);
      expect(detail.body.data.result).toBe("CONFIRMED_MATCH");
    });

    it("POST /screening/customers/:id/sanctions re-checks an EXISTING customer without blocking, auto-flags on CONFIRMED_MATCH, and audits customer.sanctions_flagged", async () => {
      const token = await tenantAdminToken(tenantAId, "sanctions-endpoint-1");

      const created = await http()
        .post("/customers")
        .set("Authorization", `Bearer ${token}`)
        .send(createCustomerBody({ fullName: "Later Confirmed Person" }))
        .expect(201);
      const customerId = created.body.data.id;

      // Simulate the customer's real name changing to a sanctions-list name
      // after onboarding (this mock's name-driven trigger requires it) —
      // directly via the fixture DB, bypassing the update flow which isn't
      // under test here.
      await ctx.adminDataSource
        .getRepository(CustomerEntity)
        .update({ id: customerId }, { fullName: "Now SANCTIONED Person" });

      const res = await http()
        .post(`/screening/customers/${customerId}/sanctions`)
        .set("Authorization", `Bearer ${token}`)
        .expect(201);

      expect(res.body.data.check.result).toBe("CONFIRMED_MATCH");

      const customer = await ctx.adminDataSource.getRepository(CustomerEntity).findOneOrFail({ where: { id: customerId } });
      expect(customer.isSanctioned).toBe(true);
      expect(customer.riskLevel).toBe("CRITICAL");

      const auditRows = await ctx.adminDataSource.query(
        `SELECT * FROM audit_log WHERE tenant_id = $1 AND action = 'customer.sanctions_flagged' AND entity_id = $2`,
        [tenantAId, customerId],
      );
      expect(auditRows).toHaveLength(1);
    });
  });

  // --- Section 10.4: fail-closed on provider outage --------------------------
  describe("fail-closed on provider outage", () => {
    it("returns 503 and creates no Customer row when the only configured provider fails with no fallback", async () => {
      const failTenant = await createTenantFixture(ctx.adminDataSource);
      await seedRiskFactorConfigsFixture(ctx.adminDataSource, failTenant.id);
      // MockProvider as primary, no fallback — TIMEOUT_TEST deterministically
      // throws ProviderTransientError (Section 7.3), exhausting retries.
      await seedScreeningProviderConfigsFixture(ctx.adminDataSource, failTenant.id);

      const token = await tenantAdminToken(failTenant.id, "fail-1");
      const countBefore = await ctx.adminDataSource.getRepository(CustomerEntity).count({ where: { tenantId: failTenant.id } });

      const res = await http()
        .post("/customers")
        .set("Authorization", `Bearer ${token}`)
        .send(createCustomerBody({ fullName: "TIMEOUT_TEST Corp" }))
        .expect(503);

      expect(res.body.error.code).toBe("SCREENING_PROVIDER_UNAVAILABLE");

      const countAfter = await ctx.adminDataSource.getRepository(CustomerEntity).count({ where: { tenantId: failTenant.id } });
      expect(countAfter).toBe(countBefore);

      const checkId = res.body.error.details.screeningCheckId;
      const check = await ctx.adminDataSource.getRepository(ScreeningCheckEntity).findOne({ where: { id: checkId } });
      expect(check!.status).toBe("FAILED");
      expect(check!.result).toBe("ERROR");
    }, 20000);
  });

  // --- Section 10.6: match review workflow ------------------------------------
  describe("match review workflow", () => {
    async function seedPendingMatch(tenantId: string, checkType: ScreeningCheckType, customerId: string) {
      const checkRepo = ctx.adminDataSource.getRepository(ScreeningCheckEntity);
      const check = await checkRepo.save(
        checkRepo.create({
          tenantId,
          customerId,
          checkType,
          provider: ScreeningProviderName.MOCK,
          inputData: { fullName: "Test Subject" },
          inputHash: "0".repeat(64),
          status: "COMPLETED" as never,
          result: "POTENTIAL_MATCH" as never,
          highestMatchScore: 72,
          providerReference: "test-ref",
          rawResponse: {},
          errorMessage: null,
          latencyMs: 5,
          trigger: "MANUAL" as never,
          triggeredBy: null,
          startedAt: new Date(),
          completedAt: new Date(),
        }),
      );
      const matchRepo = ctx.adminDataSource.getRepository(ScreeningMatchEntity);
      const match = await matchRepo.save(
        matchRepo.create({
          tenantId,
          screeningCheckId: check.id,
          customerId,
          listSource: "UN_CONSOLIDATED",
          matchName: "Test Subject",
          matchScore: 72,
          matchData: {},
          reviewStatus: "PENDING_REVIEW" as never,
          decision: null,
          decisionReason: null,
          reviewedBy: null,
          reviewedAt: null,
          createdAt: new Date(),
        }),
      );
      return { check, match };
    }

    async function seedCleanCustomer(tenantId: string, token: string, fullName: string): Promise<string> {
      const res = await http()
        .post("/customers")
        .set("Authorization", `Bearer ${token}`)
        .send(createCustomerBody({ fullName }))
        .expect(201);
      return res.body.data.id;
    }

    it("FALSE_POSITIVE leaves customer flags unchanged and is final (second review returns 409)", async () => {
      const token = await complianceToken(tenantAId, "review-1");
      const customerId = await seedCleanCustomer(tenantAId, token, "FP Review Subject");
      const { match } = await seedPendingMatch(tenantAId, ScreeningCheckType.SANCTIONS, customerId);

      const res = await http()
        .post(`/screening/matches/${match.id}/review`)
        .set("Authorization", `Bearer ${token}`)
        .send({ decision: "FALSE_POSITIVE", decisionReason: "Different person, DOB does not match." })
        .expect(201);

      expect(res.body.data.decision).toBe("FALSE_POSITIVE");
      expect(res.body.data.reviewStatus).toBe("REVIEWED");
      expect(res.body.data.checkType).toBe("SANCTIONS");

      const customer = await ctx.adminDataSource.getRepository(CustomerEntity).findOneOrFail({ where: { id: customerId } });
      expect(customer.isSanctioned).toBe(false);

      const again = await http()
        .post(`/screening/matches/${match.id}/review`)
        .set("Authorization", `Bearer ${token}`)
        .send({ decision: "TRUE_POSITIVE", decisionReason: "changed my mind" })
        .expect(409);
      expect(again.body.error.code).toBe("MATCH_ALREADY_REVIEWED");
    });

    it("TRUE_POSITIVE on a SANCTIONS match sets is_sanctioned, re-scores, and emits customer.sanctions_confirmed", async () => {
      const token = await complianceToken(tenantAId, "review-2");
      const customerId = await seedCleanCustomer(tenantAId, token, "TP Sanctions Subject");
      const { match } = await seedPendingMatch(tenantAId, ScreeningCheckType.SANCTIONS, customerId);

      const emitter = ctx.app.get(EventEmitter2);
      const seen: unknown[] = [];
      const listener = (payload: unknown) => seen.push(payload);
      emitter.on("customer.sanctions_confirmed", listener);

      try {
        await http()
          .post(`/screening/matches/${match.id}/review`)
          .set("Authorization", `Bearer ${token}`)
          .send({ decision: "TRUE_POSITIVE", decisionReason: "Confirmed via secondary ID check." })
          .expect(201)
          .then((res) => {
            expect(res.body.data.checkType).toBe("SANCTIONS");
          });

        const customer = await ctx.adminDataSource.getRepository(CustomerEntity).findOneOrFail({ where: { id: customerId } });
        expect(customer.isSanctioned).toBe(true);
        expect(customer.riskLevel).toBe("CRITICAL");

        expect(seen).toHaveLength(1);
        expect((seen[0] as { customerId: string }).customerId).toBe(customerId);

        // customer.sanctions_confirmed must be a real audit_log row too, not just the
        // in-process event above — same principle already enforced for the automated
        // customer.sanctions_flagged path (see the on-demand sanctions test below).
        const auditRows = await ctx.adminDataSource.query(
          `SELECT * FROM audit_log WHERE tenant_id = $1 AND action = 'customer.sanctions_confirmed' AND entity_id = $2`,
          [tenantAId, customerId],
        );
        expect(auditRows).toHaveLength(1);
      } finally {
        emitter.off("customer.sanctions_confirmed", listener);
      }
    });

    it("TRUE_POSITIVE on a PEP match sets is_pep, re-scores, and audits customer.pep_confirmed", async () => {
      const token = await complianceToken(tenantAId, "review-pep-1");
      // Name deliberately avoids the literal substring "PEP" (MockProvider upper-cases
      // fullName and matches on it — see mock.provider.ts — so a name containing "PEP"
      // would trigger a real, automated CONFIRMED_MATCH during this customer's own async
      // onboarding screen, racing the manually-seeded pending match below).
      const customerId = await seedCleanCustomer(tenantAId, token, "TP Review Subject");
      const { match } = await seedPendingMatch(tenantAId, ScreeningCheckType.PEP, customerId);

      await http()
        .post(`/screening/matches/${match.id}/review`)
        .set("Authorization", `Bearer ${token}`)
        .send({ decision: "TRUE_POSITIVE", decisionReason: "Confirmed via secondary ID check." })
        .expect(201)
        .then((res) => {
          expect(res.body.data.checkType).toBe("PEP");
        });

      const customer = await ctx.adminDataSource.getRepository(CustomerEntity).findOneOrFail({ where: { id: customerId } });
      expect(customer.isPep).toBe(true);
      expect(customer.riskLevel).toBe("CRITICAL");

      const auditRows = await ctx.adminDataSource.query(
        `SELECT * FROM audit_log WHERE tenant_id = $1 AND action = 'customer.pep_confirmed' AND entity_id = $2`,
        [tenantAId, customerId],
      );
      expect(auditRows).toHaveLength(1);
    });

    it("review without a decisionReason returns 400", async () => {
      const token = await complianceToken(tenantAId, "review-3");
      const customerId = await seedCleanCustomer(tenantAId, token, "No Reason Subject");
      const { match } = await seedPendingMatch(tenantAId, ScreeningCheckType.PEP, customerId);

      await http()
        .post(`/screening/matches/${match.id}/review`)
        .set("Authorization", `Bearer ${token}`)
        .send({ decision: "FALSE_POSITIVE" })
        .expect(400);
    });

    it("review as VIEWER role returns 403", async () => {
      const adminToken = await tenantAdminToken(tenantAId, "review-4");
      const customerId = await seedCleanCustomer(tenantAId, adminToken, "Viewer Blocked Subject");
      const { match } = await seedPendingMatch(tenantAId, ScreeningCheckType.PEP, customerId);

      const { user, password } = await createUserFixture(ctx.adminDataSource, tenantAId, {
        email: "viewer-scr@test.dev",
        role: UserRole.VIEWER,
      });
      const viewerToken = await loginAs(user.email, password);

      await http()
        .post(`/screening/matches/${match.id}/review`)
        .set("Authorization", `Bearer ${viewerToken}`)
        .send({ decision: "FALSE_POSITIVE", decisionReason: "x" })
        .expect(403);
    });

    it("GET /screening/matches and GET /screening/matches/:id both report the correct checkType, even mixed on one page", async () => {
      // screening_match has no check_type column of its own (Section 3.3) —
      // this exercises the batch lookup that resolves it from each match's
      // parent screening_check, specifically with more than one distinct
      // checkType on the same page (the scenario that would silently zip
      // matches to the wrong checkType if the lookup were built wrong).
      const token = await complianceToken(tenantAId, "checktype-mix-1");
      const customerId = await seedCleanCustomer(tenantAId, token, "Mixed CheckType Subject");
      const { match: sanctionsMatch } = await seedPendingMatch(tenantAId, ScreeningCheckType.SANCTIONS, customerId);
      const { match: pepMatch } = await seedPendingMatch(tenantAId, ScreeningCheckType.PEP, customerId);
      const { match: adverseMatch } = await seedPendingMatch(tenantAId, ScreeningCheckType.ADVERSE_MEDIA, customerId);

      const list = await http()
        .get("/screening/matches")
        .query({ customer_id: customerId })
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      const byId = new Map(list.body.data.data.map((m: { id: string; checkType: string }) => [m.id, m.checkType]));
      expect(byId.get(sanctionsMatch.id)).toBe("SANCTIONS");
      expect(byId.get(pepMatch.id)).toBe("PEP");
      expect(byId.get(adverseMatch.id)).toBe("ADVERSE_MEDIA");

      const detail = await http()
        .get(`/screening/matches/${pepMatch.id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(detail.body.data.checkType).toBe("PEP");
    });
  });

  // --- Section 10.7: tenant isolation -----------------------------------------
  describe("tenant isolation", () => {
    it("GET /screening/matches only returns the caller's own tenant's matches", async () => {
      const tokenA = await complianceToken(tenantAId, "iso-1a");
      const tokenB = await complianceToken(tenantBId, "iso-1b");

      const customerAId = await http()
        .post("/customers")
        .set("Authorization", `Bearer ${tokenA}`)
        .send(createCustomerBody({ fullName: "Tenant A Subject" }))
        .expect(201)
        .then((r) => r.body.data.id);

      const checkRepo = ctx.adminDataSource.getRepository(ScreeningCheckEntity);
      const matchRepo = ctx.adminDataSource.getRepository(ScreeningMatchEntity);
      const check = await checkRepo.save(
        checkRepo.create({
          tenantId: tenantAId,
          customerId: customerAId,
          checkType: ScreeningCheckType.PEP,
          provider: ScreeningProviderName.MOCK,
          inputData: {},
          inputHash: "1".repeat(64),
          status: "COMPLETED" as never,
          result: "POTENTIAL_MATCH" as never,
          highestMatchScore: 65,
          providerReference: "ref",
          rawResponse: {},
          errorMessage: null,
          latencyMs: 1,
          trigger: "MANUAL" as never,
          triggeredBy: null,
          startedAt: new Date(),
          completedAt: new Date(),
        }),
      );
      const match = await matchRepo.save(
        matchRepo.create({
          tenantId: tenantAId,
          screeningCheckId: check.id,
          customerId: customerAId,
          listSource: "DOMESTIC_PEP",
          matchName: "Tenant A Subject",
          matchScore: 65,
          matchData: {},
          reviewStatus: "PENDING_REVIEW" as never,
          decision: null,
          decisionReason: null,
          reviewedBy: null,
          reviewedAt: null,
          createdAt: new Date(),
        }),
      );

      const listB = await http().get("/screening/matches").set("Authorization", `Bearer ${tokenB}`).expect(200);
      expect(listB.body.data.data.some((m: { id: string }) => m.id === match.id)).toBe(false);

      const listA = await http().get("/screening/matches").set("Authorization", `Bearer ${tokenA}`).expect(200);
      expect(listA.body.data.data.some((m: { id: string }) => m.id === match.id)).toBe(true);
      const found = listA.body.data.data.find((m: { id: string }) => m.id === match.id);
      expect(found.checkType).toBe("PEP");
    });

    it("reviewing a different tenant's match by id returns 404", async () => {
      const tokenA = await complianceToken(tenantAId, "iso-2a");
      const tokenB = await complianceToken(tenantBId, "iso-2b");

      const customerBId = await http()
        .post("/customers")
        .set("Authorization", `Bearer ${tokenB}`)
        .send(createCustomerBody({ fullName: "Tenant B Subject" }))
        .expect(201)
        .then((r) => r.body.data.id);

      const checkRepo = ctx.adminDataSource.getRepository(ScreeningCheckEntity);
      const matchRepo = ctx.adminDataSource.getRepository(ScreeningMatchEntity);
      const check = await checkRepo.save(
        checkRepo.create({
          tenantId: tenantBId,
          customerId: customerBId,
          checkType: ScreeningCheckType.PEP,
          provider: ScreeningProviderName.MOCK,
          inputData: {},
          inputHash: "2".repeat(64),
          status: "COMPLETED" as never,
          result: "POTENTIAL_MATCH" as never,
          highestMatchScore: 65,
          providerReference: "ref",
          rawResponse: {},
          errorMessage: null,
          latencyMs: 1,
          trigger: "MANUAL" as never,
          triggeredBy: null,
          startedAt: new Date(),
          completedAt: new Date(),
        }),
      );
      const match = await matchRepo.save(
        matchRepo.create({
          tenantId: tenantBId,
          screeningCheckId: check.id,
          customerId: customerBId,
          listSource: "DOMESTIC_PEP",
          matchName: "Tenant B Subject",
          matchScore: 65,
          matchData: {},
          reviewStatus: "PENDING_REVIEW" as never,
          decision: null,
          decisionReason: null,
          reviewedBy: null,
          reviewedAt: null,
          createdAt: new Date(),
        }),
      );

      await http()
        .post(`/screening/matches/${match.id}/review`)
        .set("Authorization", `Bearer ${tokenA}`)
        .send({ decision: "FALSE_POSITIVE", decisionReason: "cross-tenant attempt" })
        .expect(404);
    });

    it("configuring providers for one tenant does not affect another's", async () => {
      const tokenA = await tenantAdminToken(tenantAId, "iso-3a");

      await http()
        .put("/screening/providers")
        .set("Authorization", `Bearer ${tokenA}`)
        .send({
          providers: [
            {
              checkType: "SANCTIONS",
              provider: "MOCK",
              isPrimary: true,
              isFallback: false,
              credentialsRef: "env://MOCK_UNUSED_A",
            },
          ],
        })
        .expect(200);

      const tenantBConfigs = await ctx.adminDataSource
        .getRepository(ScreeningProviderConfigEntity)
        .find({ where: { tenantId: tenantBId } });
      // Tenant B's original 3-checkType seed set is untouched.
      expect(tenantBConfigs).toHaveLength(3);
    });
  });
});
