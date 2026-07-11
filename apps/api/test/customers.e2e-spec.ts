import request from "supertest";
import { CustomerEntity, PepDetailsEntity, RiskScoreHistoryEntity } from "@regops/db";
import { UserRole } from "@regops/shared";
import {
  closeTestContext,
  createTenantFixture,
  createUserFixture,
  createTestContext,
  seedRiskFactorConfigsFixture,
  seedScreeningProviderConfigsFixture,
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
    // Section 5.1 (Backend Prompt 3): customer creation now runs a
    // synchronous sanctions pre-screen, which requires a configured
    // provider for the tenant, same reasoning as risk-rescoring.e2e-spec.ts.
    await seedScreeningProviderConfigsFixture(ctx.adminDataSource, tenantAId);
    await seedScreeningProviderConfigsFixture(ctx.adminDataSource, tenantBId);
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

  async function roleToken(tenantId: string, emailSuffix: string, role: UserRole): Promise<string> {
    const { user, password } = await createUserFixture(ctx.adminDataSource, tenantId, {
      email: `${role.toLowerCase()}-${emailSuffix}@test.dev`,
      role,
    });
    return loginAs(user.email, password);
  }

  function validPepDetails(overrides: Record<string, unknown> = {}) {
    return {
      pepCategory: "DOMESTIC",
      pepPosition: "Senator",
      pepInstitution: "National Assembly",
      pepCountry: "NG",
      pepStatus: "CURRENT",
      pepStartDate: "2020-01-01",
      sourceOfWealth: "Salary and investments.",
      nextReviewDate: "2027-01-01",
      ...overrides,
    };
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
          pepDetails: {
            pepCategory: "DOMESTIC",
            pepPosition: "Senator",
            pepInstitution: "National Assembly",
            pepCountry: "IR",
            pepStatus: "CURRENT",
            pepStartDate: "2020-01-01",
            sourceOfWealth: "Salary and investments.",
            nextReviewDate: "2027-01-01",
          },
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

  // --- Backend Prompt 3.5, Section 2: PEP onboarding + senior approval -------
  describe("PEP creation and approval", () => {
    it("creating a customerType PEP customer without pepDetails returns 400", async () => {
      const token = await tenantAdminToken(tenantAId, "pep-1");

      const res = await http()
        .post("/customers")
        .set("Authorization", `Bearer ${token}`)
        .send({
          cbsCustomerId: "CUST-PEP-001",
          fullName: "Missing Pep Details",
          customerType: "PEP",
          kycTier: 1,
          onboardedAt: "2024-01-01",
        })
        .expect(400);

      expect(res.body.error.code).toBe("PEP_DETAILS_REQUIRED");
    });

    it("customerType PEP with pepDetails lands in PENDING_EDD_APPROVAL, not ACTIVE, and creates a pep_details row", async () => {
      const token = await tenantAdminToken(tenantAId, "pep-2");

      // Name deliberately avoids the literal substring "PEP" — MockProvider upper-cases
      // fullName and matches on it regardless of check type (see mock.provider.ts), so a
      // name containing "PEP" would trigger a real synchronous SANCTIONS_MATCH_BLOCK here,
      // unrelated to what this test is actually checking (same trap fixed in screening.e2e-spec.ts).
      const res = await http()
        .post("/customers")
        .set("Authorization", `Bearer ${token}`)
        .send({
          cbsCustomerId: "CUST-PEP-002",
          fullName: "Pending Review Subject",
          customerType: "PEP",
          kycTier: 1,
          onboardedAt: "2024-01-01",
          pepDetails: validPepDetails(),
        })
        .expect(201);

      expect(res.body.data.status).toBe("PENDING_EDD_APPROVAL");
      expect(res.body.data.isPep).toBe(true);

      const pepDetails = await ctx.adminDataSource
        .getRepository(PepDetailsEntity)
        .findOne({ where: { customerId: res.body.data.id } });
      expect(pepDetails).not.toBeNull();
      expect(pepDetails?.pepPosition).toBe("Senator");
      expect(pepDetails?.eddApprovedBy).toBeNull();
      expect(pepDetails?.eddApprovedAt).toBeNull();
    });

    it("an otherwise-INDIVIDUAL customer with isPep: true also lands in PENDING_EDD_APPROVAL (the 'or is_pep is being set true' signal)", async () => {
      const token = await tenantAdminToken(tenantAId, "pep-3");

      // Same MockProvider-trigger-avoidance reasoning as the test above.
      const res = await http()
        .post("/customers")
        .set("Authorization", `Bearer ${token}`)
        .send({
          cbsCustomerId: "CUST-PEP-003",
          fullName: "Individual But Flagged",
          customerType: "INDIVIDUAL",
          isPep: true,
          kycTier: 1,
          onboardedAt: "2024-01-01",
          pepDetails: validPepDetails(),
        })
        .expect(201);

      expect(res.body.data.status).toBe("PENDING_EDD_APPROVAL");
      expect(res.body.data.customerType).toBe("INDIVIDUAL");
    });

    it("isPepByAssociation: true without associatedPepName returns 400", async () => {
      const token = await tenantAdminToken(tenantAId, "pep-4");

      const res = await http()
        .post("/customers")
        .set("Authorization", `Bearer ${token}`)
        .send({
          cbsCustomerId: "CUST-PEP-004",
          fullName: "Associated Pep Missing Name",
          customerType: "PEP",
          kycTier: 1,
          onboardedAt: "2024-01-01",
          pepDetails: validPepDetails({ isPepByAssociation: true }),
        })
        .expect(400);

      expect(res.body.success).toBe(false);
    });

    it("PATCHing status to PENDING_EDD_APPROVAL directly is rejected with 400 — system-managed only", async () => {
      const token = await tenantAdminToken(tenantAId, "pep-5");

      const created = await http()
        .post("/customers")
        .set("Authorization", `Bearer ${token}`)
        .send({
          cbsCustomerId: "CUST-PEP-005",
          fullName: "Active Customer",
          customerType: "INDIVIDUAL",
          kycTier: 1,
          onboardedAt: "2024-01-01",
        })
        .expect(201);

      const res = await http()
        .patch(`/customers/${created.body.data.id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status: "PENDING_EDD_APPROVAL" })
        .expect(400);

      expect(res.body.error.code).toBe("STATUS_NOT_DIRECTLY_SETTABLE");
    });

    it("PATCHing status on a PENDING_EDD_APPROVAL customer is rejected with 409 — must use approve-pep", async () => {
      const token = await tenantAdminToken(tenantAId, "pep-6");

      const created = await http()
        .post("/customers")
        .set("Authorization", `Bearer ${token}`)
        .send({
          cbsCustomerId: "CUST-PEP-006",
          fullName: "Pending Bypass Attempt",
          customerType: "PEP",
          kycTier: 1,
          onboardedAt: "2024-01-01",
          pepDetails: validPepDetails(),
        })
        .expect(201);

      const res = await http()
        .patch(`/customers/${created.body.data.id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status: "ACTIVE" })
        .expect(409);

      expect(res.body.error.code).toBe("PEP_APPROVAL_REQUIRED");
    });

    it("TENANT_ADMIN approves a pending PEP customer: status -> ACTIVE, eddApprovedBy/eddApprovedAt populated, audit-logged", async () => {
      const token = await tenantAdminToken(tenantAId, "pep-7");

      const created = await http()
        .post("/customers")
        .set("Authorization", `Bearer ${token}`)
        .send({
          cbsCustomerId: "CUST-PEP-007",
          fullName: "Approve Me",
          customerType: "PEP",
          kycTier: 1,
          onboardedAt: "2024-01-01",
          pepDetails: validPepDetails(),
        })
        .expect(201);

      const res = await http()
        .post(`/customers/${created.body.data.id}/approve-pep`)
        .set("Authorization", `Bearer ${token}`)
        .expect(201);

      expect(res.body.data.status).toBe("ACTIVE");

      const pepDetails = await ctx.adminDataSource
        .getRepository(PepDetailsEntity)
        .findOneOrFail({ where: { customerId: created.body.data.id } });
      expect(pepDetails.eddApprovedBy).not.toBeNull();
      expect(pepDetails.eddApprovedAt).not.toBeNull();

      const auditRows = await ctx.adminDataSource.query(
        `SELECT action, after_state FROM audit_log WHERE entity_id = $1 AND action = 'customer.pep_approved'`,
        [created.body.data.id],
      );
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0].after_state.status).toBe("ACTIVE");
    });

    it("COMPLIANCE_OFFICER can also approve", async () => {
      const adminToken = await tenantAdminToken(tenantAId, "pep-8");
      const complianceToken = await roleToken(tenantAId, "pep-8", UserRole.COMPLIANCE_OFFICER);

      const created = await http()
        .post("/customers")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          cbsCustomerId: "CUST-PEP-008",
          fullName: "Compliance Approves",
          customerType: "PEP",
          kycTier: 1,
          onboardedAt: "2024-01-01",
          pepDetails: validPepDetails(),
        })
        .expect(201);

      await http()
        .post(`/customers/${created.body.data.id}/approve-pep`)
        .set("Authorization", `Bearer ${complianceToken}`)
        .expect(201);
    });

    it("VIEWER role cannot approve — 403", async () => {
      const adminToken = await tenantAdminToken(tenantAId, "pep-9");
      const viewerToken = await roleToken(tenantAId, "pep-9", UserRole.VIEWER);

      const created = await http()
        .post("/customers")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          cbsCustomerId: "CUST-PEP-009",
          fullName: "Viewer Cannot Approve",
          customerType: "PEP",
          kycTier: 1,
          onboardedAt: "2024-01-01",
          pepDetails: validPepDetails(),
        })
        .expect(201);

      await http()
        .post(`/customers/${created.body.data.id}/approve-pep`)
        .set("Authorization", `Bearer ${viewerToken}`)
        .expect(403);
    });

    it("approving an already-ACTIVE customer returns 409", async () => {
      const token = await tenantAdminToken(tenantAId, "pep-10");

      const created = await http()
        .post("/customers")
        .set("Authorization", `Bearer ${token}`)
        .send({
          cbsCustomerId: "CUST-PEP-010",
          fullName: "Already Active",
          customerType: "INDIVIDUAL",
          kycTier: 1,
          onboardedAt: "2024-01-01",
        })
        .expect(201);

      const res = await http()
        .post(`/customers/${created.body.data.id}/approve-pep`)
        .set("Authorization", `Bearer ${token}`)
        .expect(409);

      expect(res.body.error.code).toBe("CUSTOMER_NOT_PENDING_EDD_APPROVAL");
    });

    it("GET /customers?status=PENDING_EDD_APPROVAL filters to only pending customers", async () => {
      const token = await tenantAdminToken(tenantAId, "pep-11");

      const created = await http()
        .post("/customers")
        .set("Authorization", `Bearer ${token}`)
        .send({
          cbsCustomerId: "CUST-PEP-011",
          fullName: "Visible While Pending",
          customerType: "PEP",
          kycTier: 1,
          onboardedAt: "2024-01-01",
          pepDetails: validPepDetails(),
        })
        .expect(201);

      const res = await http()
        .get("/customers?status=PENDING_EDD_APPROVAL")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      const ids = res.body.data.data.map((c: { id: string }) => c.id);
      expect(ids).toContain(created.body.data.id);
      for (const c of res.body.data.data as { status: string }[]) {
        expect(c.status).toBe("PENDING_EDD_APPROVAL");
      }
    });
  });

  // --- Backend Prompt 3.5, Section 3: profile photo ---------------------------
  describe("photo", () => {
    it("uploads a photo, round-trips through FileStorage, then deletes it (404 afterward)", async () => {
      const token = await tenantAdminToken(tenantAId, "photo-1");

      const created = await http()
        .post("/customers")
        .set("Authorization", `Bearer ${token}`)
        .send({
          cbsCustomerId: "CUST-PHOTO-001",
          fullName: "Photo Subject",
          customerType: "INDIVIDUAL",
          kycTier: 1,
          onboardedAt: "2024-01-01",
        })
        .expect(201);
      const id = created.body.data.id;

      const fakeImageBytes = Buffer.from("fake-png-bytes-for-testing-only");

      const uploadRes = await http()
        .post(`/customers/${id}/photo`)
        .set("Authorization", `Bearer ${token}`)
        .attach("file", fakeImageBytes, { filename: "photo.png", contentType: "image/png" })
        .expect(201);

      expect(uploadRes.body.data.photoUrl).not.toBeNull();
      expect(uploadRes.body.data.photoUrl).toContain(id);

      // .buffer()/.parse() force a raw Buffer body regardless of content-type — the streamed
      // response has no content-length header at all (chunked transfer), so this is the only
      // reliable way to verify the actual round-tripped bytes, not just the status/headers.
      const downloadRes = await http()
        .get(`/customers/${id}/photo`)
        .set("Authorization", `Bearer ${token}`)
        .buffer()
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(downloadRes.headers["content-type"]).toBe("image/png");
      expect(Buffer.isBuffer(downloadRes.body)).toBe(true);
      expect((downloadRes.body as Buffer).equals(fakeImageBytes)).toBe(true);

      const auditAfterUpload = await ctx.adminDataSource.query(
        `SELECT action FROM audit_log WHERE entity_id = $1 AND action = 'customer.photo.upload'`,
        [id],
      );
      expect(auditAfterUpload).toHaveLength(1);

      await http().delete(`/customers/${id}/photo`).set("Authorization", `Bearer ${token}`).expect(204);

      const stored = await ctx.adminDataSource.getRepository(CustomerEntity).findOneOrFail({ where: { id } });
      expect(stored.photoUrl).toBeNull();

      await http().get(`/customers/${id}/photo`).set("Authorization", `Bearer ${token}`).expect(404);

      const auditAfterDelete = await ctx.adminDataSource.query(
        `SELECT action FROM audit_log WHERE entity_id = $1 AND action = 'customer.photo.delete'`,
        [id],
      );
      expect(auditAfterDelete).toHaveLength(1);
    });

    it("rejects an unsupported content type with 400", async () => {
      const token = await tenantAdminToken(tenantAId, "photo-2");

      const created = await http()
        .post("/customers")
        .set("Authorization", `Bearer ${token}`)
        .send({
          cbsCustomerId: "CUST-PHOTO-002",
          fullName: "Bad Content Type",
          customerType: "INDIVIDUAL",
          kycTier: 1,
          onboardedAt: "2024-01-01",
        })
        .expect(201);

      const res = await http()
        .post(`/customers/${created.body.data.id}/photo`)
        .set("Authorization", `Bearer ${token}`)
        .attach("file", Buffer.from("not-an-image"), { filename: "notes.txt", contentType: "text/plain" })
        .expect(400);

      expect(res.body.error.code).toBe("UNSUPPORTED_PHOTO_TYPE");
    });

    it("deleting a photo that doesn't exist returns 404", async () => {
      const token = await tenantAdminToken(tenantAId, "photo-3");

      const created = await http()
        .post("/customers")
        .set("Authorization", `Bearer ${token}`)
        .send({
          cbsCustomerId: "CUST-PHOTO-003",
          fullName: "No Photo Yet",
          customerType: "INDIVIDUAL",
          kycTier: 1,
          onboardedAt: "2024-01-01",
        })
        .expect(201);

      await http()
        .delete(`/customers/${created.body.data.id}/photo`)
        .set("Authorization", `Bearer ${token}`)
        .expect(404);
    });
  });

  // --- Backend Prompt 3.5, Section 4: CSV export -------------------------------
  describe("export", () => {
    it("returns a CSV with the correct content-type/content-disposition, masked PII, and respects filters", async () => {
      const token = await tenantAdminToken(tenantAId, "export-1");

      await http()
        .post("/customers")
        .set("Authorization", `Bearer ${token}`)
        .send({
          cbsCustomerId: "CUST-EXPORT-001",
          fullName: "Export Included",
          bvn: "55566677788",
          customerType: "SME",
          kycTier: 1,
          onboardedAt: "2024-01-01",
        })
        .expect(201);

      await http()
        .post("/customers")
        .set("Authorization", `Bearer ${token}`)
        .send({
          cbsCustomerId: "CUST-EXPORT-002",
          fullName: "Export Excluded",
          customerType: "CORPORATE",
          kycTier: 1,
          onboardedAt: "2024-01-01",
        })
        .expect(201);

      const res = await http()
        .get("/customers/export?customer_type=SME")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      expect(res.headers["content-type"]).toContain("text/csv");
      expect(res.headers["content-disposition"]).toContain("attachment");

      const body = res.text;
      expect(body).toContain("Export Included");
      expect(body).not.toContain("Export Excluded");
      expect(body).toContain("*******7788"); // masked bvn, never the plaintext
      expect(body).not.toContain("55566677788");
    });

    it("is accessible to VIEWER, same role-gating as GET /customers (no @Roles restriction)", async () => {
      const adminToken = await tenantAdminToken(tenantAId, "export-2");
      const viewerToken = await roleToken(tenantAId, "export-2", UserRole.VIEWER);

      await http()
        .post("/customers")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          cbsCustomerId: "CUST-EXPORT-003",
          fullName: "Viewer Export Check",
          customerType: "INDIVIDUAL",
          kycTier: 1,
          onboardedAt: "2024-01-01",
        })
        .expect(201);

      await http().get("/customers/export").set("Authorization", `Bearer ${viewerToken}`).expect(200);
    });

    it("respects tenant isolation — tenant B's export never contains tenant A's customers", async () => {
      const tokenA = await tenantAdminToken(tenantAId, "export-4a");
      const tokenB = await tenantAdminToken(tenantBId, "export-4b");

      await http()
        .post("/customers")
        .set("Authorization", `Bearer ${tokenA}`)
        .send({
          cbsCustomerId: "CUST-EXPORT-005",
          fullName: "Tenant A Export Only",
          customerType: "INDIVIDUAL",
          kycTier: 1,
          onboardedAt: "2024-01-01",
        })
        .expect(201);

      const res = await http().get("/customers/export").set("Authorization", `Bearer ${tokenB}`).expect(200);
      expect(res.text).not.toContain("Tenant A Export Only");
    });
  });
});
