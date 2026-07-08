import request from "supertest";
import { UserRole } from "@regops/shared";
import {
  closeTestContext,
  createTenantFixture,
  createUserFixture,
  createTestContext,
  seedRiskFactorConfigsFixture,
  TestContext,
} from "./utils/test-app";

describe("Customer batch ingestion — API surface (e2e)", () => {
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
      email: `ingestion-admin-${emailSuffix}@test.dev`,
      role: UserRole.TENANT_ADMIN,
    });
    return loginAs(user.email, password);
  }

  const SAMPLE_CSV =
    "cbs_customer_id,full_name,email,phone,bvn,nin,date_of_birth,customer_type,occupation,country,nationality,kyc_tier,onboarded_at\n" +
    "CUST-UPLOAD-001,Upload Test,,,,,,INDIVIDUAL,,NG,,2,2024-01-01\n";

  it("POST /customers/batch returns a jobId immediately with status 'queued'", async () => {
    const token = await tenantAdminToken(tenantAId, "1");

    const res = await http()
      .post("/customers/batch")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from(SAMPLE_CSV), { filename: "customers.csv", contentType: "text/csv" })
      .expect(201);

    expect(res.body.data.status).toBe("queued");
    expect(typeof res.body.data.jobId).toBe("string");
  });

  it("rejects the upload with 400 when no file is attached", async () => {
    const token = await tenantAdminToken(tenantAId, "2");

    await http().post("/customers/batch").set("Authorization", `Bearer ${token}`).expect(400);
  });

  it("rejects the upload as 403 for a VIEWER role", async () => {
    const { user, password } = await createUserFixture(ctx.adminDataSource, tenantAId, {
      email: "ingestion-viewer-1@test.dev",
      role: UserRole.VIEWER,
    });
    const token = await loginAs(user.email, password);

    await http()
      .post("/customers/batch")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from(SAMPLE_CSV), { filename: "customers.csv", contentType: "text/csv" })
      .expect(403);
  });

  it("tenant isolation: tenant B cannot query the status of a job tenant A uploaded", async () => {
    const tokenA = await tenantAdminToken(tenantAId, "iso-a");
    const tokenB = await tenantAdminToken(tenantBId, "iso-b");

    const uploadRes = await http()
      .post("/customers/batch")
      .set("Authorization", `Bearer ${tokenA}`)
      .attach("file", Buffer.from(SAMPLE_CSV), { filename: "customers.csv", contentType: "text/csv" })
      .expect(201);
    const jobId = uploadRes.body.data.jobId;

    await http().get(`/customers/batch/${jobId}`).set("Authorization", `Bearer ${tokenA}`).expect(200);
    await http().get(`/customers/batch/${jobId}`).set("Authorization", `Bearer ${tokenB}`).expect(404);
  });
});
