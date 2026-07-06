import request from "supertest";
import { DataSource } from "typeorm";
import { UserEntity } from "@regops/db";
import { UserRole } from "@regops/shared";
import {
  closeTestContext,
  createTenantFixture,
  createUserFixture,
  createTestContext,
  TestContext,
} from "./utils/test-app";

describe("Tenant isolation (e2e)", () => {
  let ctx: TestContext;
  let tenantAId: string;
  let tenantBId: string;
  let platformTenantId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    tenantAId = (await createTenantFixture(ctx.adminDataSource)).id;
    tenantBId = (await createTenantFixture(ctx.adminDataSource)).id;
    platformTenantId = (await createTenantFixture(ctx.adminDataSource)).id;
  });

  afterAll(async () => {
    await closeTestContext(ctx);
  });

  const http = () => request(ctx.app.getHttpServer());

  async function loginAs(email: string, password: string): Promise<string> {
    const res = await http().post("/auth/login").send({ email, password }).expect(200);
    return res.body.data.accessToken;
  }

  it("only shows a tenant A user the users belonging to tenant A", async () => {
    const { user: tenantAAdmin, password } = await createUserFixture(
      ctx.adminDataSource,
      tenantAId,
      { email: "tenantA-admin@test.dev", role: UserRole.TENANT_ADMIN },
    );
    await createUserFixture(ctx.adminDataSource, tenantAId, { email: "tenantA-viewer@test.dev" });
    await createUserFixture(ctx.adminDataSource, tenantBId, { email: "tenantB-viewer@test.dev" });

    const token = await loginAs(tenantAAdmin.email, password);
    const res = await http().get("/users").set("Authorization", `Bearer ${token}`).expect(200);

    const emails = res.body.data.map((u: { email: string }) => u.email);
    expect(emails).toContain("tenantA-admin@test.dev");
    expect(emails).toContain("tenantA-viewer@test.dev");
    expect(emails).not.toContain("tenantB-viewer@test.dev");
  });

  it("returns 404 (not 403) when a tenant A user reads a tenant B user by id", async () => {
    const { user: tenantAAdmin, password } = await createUserFixture(
      ctx.adminDataSource,
      tenantAId,
      { email: "tenantA-admin-2@test.dev", role: UserRole.TENANT_ADMIN },
    );
    const { user: tenantBUser } = await createUserFixture(ctx.adminDataSource, tenantBId, {
      email: "tenantB-target@test.dev",
    });

    const token = await loginAs(tenantAAdmin.email, password);
    const res = await http()
      .get(`/users/${tenantBUser.id}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(404);

    expect(res.body.error.code).toBe("USER_NOT_FOUND");
  });

  it("only lets a tenant A user create users within tenant A", async () => {
    const { user: tenantAAdmin, password } = await createUserFixture(
      ctx.adminDataSource,
      tenantAId,
      { email: "tenantA-admin-3@test.dev", role: UserRole.TENANT_ADMIN },
    );

    const token = await loginAs(tenantAAdmin.email, password);
    const res = await http()
      .post("/users")
      .set("Authorization", `Bearer ${token}`)
      .send({
        email: "new-hire@test.dev",
        password: "SomeStrongPassword123",
        fullName: "New Hire",
        role: UserRole.VIEWER,
      })
      .expect(201);

    expect(res.body.data.tenantId).toBe(tenantAId);

    const created = await ctx.adminDataSource
      .getRepository(UserEntity)
      .findOne({ where: { email: "new-hire@test.dev" } });
    expect(created?.tenantId).toBe(tenantAId);
  });

  it("lets SUPER_ADMIN read across tenants only with X-Tenant-Override", async () => {
    const { user: superAdmin, password } = await createUserFixture(
      ctx.adminDataSource,
      platformTenantId,
      { email: "super-admin@test.dev", role: UserRole.SUPER_ADMIN },
    );
    await createUserFixture(ctx.adminDataSource, tenantBId, { email: "tenantB-only@test.dev" });

    const token = await loginAs(superAdmin.email, password);

    const overrideRes = await http()
      .get("/users")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Tenant-Override", tenantBId)
      .expect(200);

    const overrideEmails = overrideRes.body.data.map((u: { email: string }) => u.email);
    expect(overrideEmails).toContain("tenantB-only@test.dev");
  });

  it("restricts SUPER_ADMIN to their own primary tenant without the override header", async () => {
    const { user: superAdmin, password } = await createUserFixture(
      ctx.adminDataSource,
      platformTenantId,
      { email: "super-admin-2@test.dev", role: UserRole.SUPER_ADMIN },
    );

    const token = await loginAs(superAdmin.email, password);
    const res = await http().get("/users").set("Authorization", `Bearer ${token}`).expect(200);

    const emails = res.body.data.map((u: { email: string }) => u.email);
    expect(emails).toContain("super-admin-2@test.dev");
    expect(emails).not.toContain("tenantB-only@test.dev");
  });

  it("enforces RLS at the database level for direct SQL under the regops_app role", async () => {
    const appDataSource = new DataSource({
      type: "postgres",
      url: process.env.DATABASE_URL,
      entities: [UserEntity],
    });
    await appDataSource.initialize();

    try {
      await createUserFixture(ctx.adminDataSource, tenantBId, {
        email: "rls-direct-target@test.dev",
      });

      const queryRunner = appDataSource.createQueryRunner();
      await queryRunner.connect();
      try {
        await queryRunner.query(
          `SELECT set_config('app.current_tenant_id', $1, true), set_config('app.bypass_rls', 'false', true)`,
          [tenantAId],
        );

        const rows = await queryRunner.query(
          `SELECT * FROM "user" WHERE email = 'rls-direct-target@test.dev'`,
        );
        expect(rows).toHaveLength(0);
      } finally {
        await queryRunner.release();
      }
    } finally {
      await appDataSource.destroy();
    }
  });
});
