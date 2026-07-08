import request from "supertest";
import { CustomerEntity, RiskScoreHistoryEntity } from "@regops/db";
import { UserRole } from "@regops/shared";
import {
  closeTestContext,
  createTenantFixture,
  createUserFixture,
  createTestContext,
  seedRiskFactorConfigsFixture,
  TestContext,
} from "./utils/test-app";

describe("Customers (e2e)", () => {
  let ctx: TestContext;
  let tenantAId: string;
  let tenantBId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    tenantAId = (await createTenantFixture(ctx.adminDataSource)).id;
    tenantBId = (await createTenantFixture(ctx.adminDataSource)).id;
    await seedRiskFactorConfigsFixture(ctx.adminDataSource, tenantAId);
    await seedRiskFactorConfigsFixture(ctx.adminDataSource, tenantBId);
  });

  afterAll(async () => {
    await closeTestContext(ctx);
  });

  const http = () => request(ctx.app.getHttpServer());

  async function loginAs(email: string, password: string): Promise<string> {
    const res = await http().post("/auth/login").send({ email, password }).expect(200);
    return res.body.data.accessToken;
  }

  async function tenantAdminToken(tenantId: string, emailSuffix: string): Promise<string> {
    const { user, password } = await createUserFixture(ctx.adminDataSource, tenantId, {
      email: `admin-${emailSuffix}@test.dev`,
      role: UserRole.TENANT_ADMIN,
    });
    return loginAs(user.email, password);
  }

  describe("create", () => {
    it("creates a customer, returns masked PII, and stores plaintext in the DB", async () => {
      const token = await tenantAdminToken(tenantAId, "create-1");

      const res = await http()
        .post("/customers")
        .set("Authorization", `Bearer ${token}`)
        .send({
          cbsCustomerId: "CUST-CREATE-001",
          fullName: "Chinedu Obi",
          bvn: "12345678901",
          customerType: "INDIVIDUAL",
          kycTier: 2,
          onboardedAt: "2024-01-01",
        })
        .expect(201);

      expect(res.body.data.bvn).toBe("*******8901");

      const stored = await ctx.adminDataSource
        .getRepository(CustomerEntity)
        .findOne({ where: { id: res.body.data.id } });
      expect(stored?.bvn).toBe("12345678901");
    });

    it("rejects a BVN that isn't exactly 11 numeric digits with a field-level 400", async () => {
      const token = await tenantAdminToken(tenantAId, "create-2");

      const res = await http()
        .post("/customers")
        .set("Authorization", `Bearer ${token}`)
        .send({
          cbsCustomerId: "CUST-CREATE-002",
          fullName: "Bad Bvn",
          bvn: "1234567890", // 10 digits
          customerType: "INDIVIDUAL",
          kycTier: 1,
          onboardedAt: "2024-01-01",
        })
        .expect(400);

      expect(res.body.success).toBe(false);
    });

    it("rejects a duplicate cbs_customer_id within the same tenant with 409", async () => {
      const token = await tenantAdminToken(tenantAId, "create-3");

      await http()
        .post("/customers")
        .set("Authorization", `Bearer ${token}`)
        .send({
          cbsCustomerId: "CUST-DUP-001",
          fullName: "First",
          customerType: "INDIVIDUAL",
          kycTier: 1,
          onboardedAt: "2024-01-01",
        })
        .expect(201);

      const res = await http()
        .post("/customers")
        .set("Authorization", `Bearer ${token}`)
        .send({
          cbsCustomerId: "CUST-DUP-001",
          fullName: "Second",
          customerType: "INDIVIDUAL",
          kycTier: 1,
          onboardedAt: "2024-01-01",
        })
        .expect(409);

      expect(res.body.error.code).toBe("CUSTOMER_CBS_ID_TAKEN");
    });

    it("allows the same cbs_customer_id across two different tenants (tenant isolation)", async () => {
      const tokenA = await tenantAdminToken(tenantAId, "create-4a");
      const tokenB = await tenantAdminToken(tenantBId, "create-4b");

      await http()
        .post("/customers")
        .set("Authorization", `Bearer ${tokenA}`)
        .send({
          cbsCustomerId: "CUST-CROSS-001",
          fullName: "Tenant A Customer",
          customerType: "INDIVIDUAL",
          kycTier: 1,
          onboardedAt: "2024-01-01",
        })
        .expect(201);

      await http()
        .post("/customers")
        .set("Authorization", `Bearer ${tokenB}`)
        .send({
          cbsCustomerId: "CUST-CROSS-001",
          fullName: "Tenant B Customer",
          customerType: "INDIVIDUAL",
          kycTier: 1,
          onboardedAt: "2024-01-01",
        })
        .expect(201);
    });

    it("respects an Idempotency-Key: replaying the same request returns the original response, not a duplicate", async () => {
      const token = await tenantAdminToken(tenantAId, "create-5");
      const payload = {
        cbsCustomerId: "CUST-IDEMPOTENT-001",
        fullName: "Idempotent Customer",
        customerType: "INDIVIDUAL",
        kycTier: 1,
        onboardedAt: "2024-01-01",
      };

      const first = await http()
        .post("/customers")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", "test-key-customers-001")
        .send(payload)
        .expect(201);

      const second = await http()
        .post("/customers")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", "test-key-customers-001")
        .send(payload)
        .expect(201);

      expect(second.body.data.id).toBe(first.body.data.id);

      const count = await ctx.adminDataSource
        .getRepository(CustomerEntity)
        .count({ where: { tenantId: tenantAId, cbsCustomerId: "CUST-IDEMPOTENT-001" } });
      expect(count).toBe(1);
    });
  });

  describe("list + filters", () => {
    it("respects tenant isolation between two tenants' customer lists", async () => {
      const tokenA = await tenantAdminToken(tenantAId, "list-1a");
      const tokenB = await tenantAdminToken(tenantBId, "list-1b");

      await http()
        .post("/customers")
        .set("Authorization", `Bearer ${tokenA}`)
        .send({
          cbsCustomerId: "CUST-LIST-A",
          fullName: "Only In Tenant A",
          customerType: "INDIVIDUAL",
          kycTier: 1,
          onboardedAt: "2024-01-01",
        })
        .expect(201);

      const resB = await http().get("/customers").set("Authorization", `Bearer ${tokenB}`).expect(200);
      const namesB = resB.body.data.data.map((c: { fullName: string }) => c.fullName);
      expect(namesB).not.toContain("Only In Tenant A");
    });

    it("filters by risk_level, combined with customer_type", async () => {
      const token = await tenantAdminToken(tenantAId, "list-2");

      await http()
        .post("/customers")
        .set("Authorization", `Bearer ${token}`)
        .send({
          cbsCustomerId: "CUST-FILTER-HIGH",
          fullName: "High Risk Corp",
          customerType: "PEP",
          country: "IR",
          kycTier: 1,
          onboardedAt: "2024-01-01",
        })
        .expect(201);

      await http()
        .post("/customers")
        .set("Authorization", `Bearer ${token}`)
        .send({
          cbsCustomerId: "CUST-FILTER-LOW",
          fullName: "Low Risk Individual",
          customerType: "INDIVIDUAL",
          kycTier: 3,
          onboardedAt: "2024-01-01",
        })
        .expect(201);

      const res = await http()
        .get("/customers?risk_level=CRITICAL&customer_type=PEP")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      const names = res.body.data.data.map((c: { fullName: string }) => c.fullName);
      expect(names).toContain("High Risk Corp");
      expect(names).not.toContain("Low Risk Individual");
    });

    it("fuzzy-matches full_name via pg_trgm", async () => {
      const token = await tenantAdminToken(tenantAId, "list-3");

      await http()
        .post("/customers")
        .set("Authorization", `Bearer ${token}`)
        .send({
          cbsCustomerId: "CUST-FUZZY-001",
          fullName: "John Smith",
          customerType: "INDIVIDUAL",
          kycTier: 1,
          onboardedAt: "2024-01-01",
        })
        .expect(201);

      const res = await http().get("/customers?q=jhon").set("Authorization", `Bearer ${token}`).expect(200);
      const names = res.body.data.data.map((c: { fullName: string }) => c.fullName);
      expect(names).toContain("John Smith");
    });
  });

  describe("update", () => {
    it("PATCHing a scoring-relevant field creates a new risk_score_history row", async () => {
      const token = await tenantAdminToken(tenantAId, "update-1");

      const created = await http()
        .post("/customers")
        .set("Authorization", `Bearer ${token}`)
        .send({
          cbsCustomerId: "CUST-UPDATE-001",
          fullName: "Update Target",
          customerType: "INDIVIDUAL",
          kycTier: 3,
          onboardedAt: "2024-01-01",
        })
        .expect(201);

      const before = await ctx.adminDataSource
        .getRepository(RiskScoreHistoryEntity)
        .count({ where: { customerId: created.body.data.id } });

      await http()
        .patch(`/customers/${created.body.data.id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ customerType: "PEP" })
        .expect(200);

      const after = await ctx.adminDataSource
        .getRepository(RiskScoreHistoryEntity)
        .count({ where: { customerId: created.body.data.id } });

      expect(after).toBe(before + 1);
    });

    it("PATCHing only email does NOT create a new risk_score_history row", async () => {
      const token = await tenantAdminToken(tenantAId, "update-2");

      const created = await http()
        .post("/customers")
        .set("Authorization", `Bearer ${token}`)
        .send({
          cbsCustomerId: "CUST-UPDATE-002",
          fullName: "Email Only Update",
          customerType: "INDIVIDUAL",
          kycTier: 3,
          onboardedAt: "2024-01-01",
        })
        .expect(201);

      const before = await ctx.adminDataSource
        .getRepository(RiskScoreHistoryEntity)
        .count({ where: { customerId: created.body.data.id } });

      await http()
        .patch(`/customers/${created.body.data.id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ email: "new-email@test.dev" })
        .expect(200);

      const after = await ctx.adminDataSource
        .getRepository(RiskScoreHistoryEntity)
        .count({ where: { customerId: created.body.data.id } });

      expect(after).toBe(before);
    });
  });

  describe("soft delete", () => {
    it("soft-deletes a customer, excluding it from subsequent GET /customers", async () => {
      const token = await tenantAdminToken(tenantAId, "delete-1");

      const created = await http()
        .post("/customers")
        .set("Authorization", `Bearer ${token}`)
        .send({
          cbsCustomerId: "CUST-DELETE-001",
          fullName: "To Be Deleted",
          customerType: "INDIVIDUAL",
          kycTier: 1,
          onboardedAt: "2024-01-01",
        })
        .expect(201);

      await http()
        .delete(`/customers/${created.body.data.id}?reason=Duplicate%20record`)
        .set("Authorization", `Bearer ${token}`)
        .expect(204);

      const listRes = await http().get("/customers").set("Authorization", `Bearer ${token}`).expect(200);
      const ids = listRes.body.data.data.map((c: { id: string }) => c.id);
      expect(ids).not.toContain(created.body.data.id);

      const stored = await ctx.adminDataSource
        .getRepository(CustomerEntity)
        .findOne({ where: { id: created.body.data.id } });
      expect(stored?.deletedAt).not.toBeNull();
    });

    it("requires a reason query param, rejecting with 400 otherwise", async () => {
      const token = await tenantAdminToken(tenantAId, "delete-2");

      const created = await http()
        .post("/customers")
        .set("Authorization", `Bearer ${token}`)
        .send({
          cbsCustomerId: "CUST-DELETE-002",
          fullName: "No Reason Given",
          customerType: "INDIVIDUAL",
          kycTier: 1,
          onboardedAt: "2024-01-01",
        })
        .expect(201);

      await http()
        .delete(`/customers/${created.body.data.id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(400);
    });
  });

  describe("PII access", () => {
    it("GET /customers/:id returns masked bvn", async () => {
      const token = await tenantAdminToken(tenantAId, "pii-1");

      const created = await http()
        .post("/customers")
        .set("Authorization", `Bearer ${token}`)
        .send({
          cbsCustomerId: "CUST-PII-001",
          fullName: "Pii Target",
          bvn: "98765432109",
          customerType: "INDIVIDUAL",
          kycTier: 1,
          onboardedAt: "2024-01-01",
        })
        .expect(201);

      const res = await http()
        .get(`/customers/${created.body.data.id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      expect(res.body.data.bvn).toBe("*******2109");
    });

    it("GET /customers/:id/pii without a reason query param returns 400", async () => {
      const { user, password } = await createUserFixture(ctx.adminDataSource, tenantAId, {
        email: "compliance-pii-1@test.dev",
        role: UserRole.COMPLIANCE_OFFICER,
      });
      const token = await loginAs(user.email, password);

      const created = await http()
        .post("/customers")
        .set("Authorization", `Bearer ${await tenantAdminToken(tenantAId, "pii-2")}`)
        .send({
          cbsCustomerId: "CUST-PII-002",
          fullName: "No Reason",
          customerType: "INDIVIDUAL",
          kycTier: 1,
          onboardedAt: "2024-01-01",
        })
        .expect(201);

      await http()
        .get(`/customers/${created.body.data.id}/pii`)
        .set("Authorization", `Bearer ${token}`)
        .expect(400);
    });

    it("GET /customers/:id/pii as VIEWER role returns 403", async () => {
      const adminToken = await tenantAdminToken(tenantAId, "pii-3");
      const { user, password } = await createUserFixture(ctx.adminDataSource, tenantAId, {
        email: "viewer-pii-1@test.dev",
        role: UserRole.VIEWER,
      });
      const viewerToken = await loginAs(user.email, password);

      const created = await http()
        .post("/customers")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          cbsCustomerId: "CUST-PII-003",
          fullName: "Viewer Blocked",
          customerType: "INDIVIDUAL",
          kycTier: 1,
          onboardedAt: "2024-01-01",
        })
        .expect(201);

      await http()
        .get(`/customers/${created.body.data.id}/pii?reason=review`)
        .set("Authorization", `Bearer ${viewerToken}`)
        .expect(403);
    });

    it("GET /customers/:id/pii as COMPLIANCE_OFFICER returns full PII and writes an audit log", async () => {
      const adminToken = await tenantAdminToken(tenantAId, "pii-4");
      const { user, password } = await createUserFixture(ctx.adminDataSource, tenantAId, {
        email: "compliance-pii-4@test.dev",
        role: UserRole.COMPLIANCE_OFFICER,
      });
      const complianceToken = await loginAs(user.email, password);

      const created = await http()
        .post("/customers")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          cbsCustomerId: "CUST-PII-004",
          fullName: "Full Pii",
          bvn: "11122233344",
          customerType: "INDIVIDUAL",
          kycTier: 1,
          onboardedAt: "2024-01-01",
        })
        .expect(201);

      const res = await http()
        .get(`/customers/${created.body.data.id}/pii?reason=KYC%20refresh`)
        .set("Authorization", `Bearer ${complianceToken}`)
        .expect(200);

      expect(res.body.data.bvn).toBe("11122233344");

      const auditRows = await ctx.adminDataSource.query(
        `SELECT action, after_state FROM audit_log WHERE entity_id = $1 AND action = 'customer.pii.view'`,
        [created.body.data.id],
      );
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0].after_state.reason).toBe("KYC refresh");
    });
  });
});
