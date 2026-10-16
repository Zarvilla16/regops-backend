import request from "supertest";
import { DataSource } from "typeorm";
import { TenantEntity, UserEntity } from "@regops/db";
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
  // Set by the "lets SUPER_ADMIN read across tenants..." test, read by the very next
  // test ("restricts SUPER_ADMIN...") — both need to agree on the real (uniquified)
  // email of the same tenantB-only fixture user; see createUserFixture's docblock.
  let tenantBOnlyEmail: string;

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
    const { user: tenantAViewer } = await createUserFixture(ctx.adminDataSource, tenantAId, {
      email: "tenantA-viewer@test.dev",
    });
    const { user: tenantBViewer } = await createUserFixture(ctx.adminDataSource, tenantBId, {
      email: "tenantB-viewer@test.dev",
    });

    const token = await loginAs(tenantAAdmin.email, password);
    const res = await http().get("/users").set("Authorization", `Bearer ${token}`).expect(200);

    // Assert against the actual persisted (uniquified) emails, not the literals passed in —
    // createUserFixture appends a random nonce to every email (see its own docblock / bug #16).
    const emails = res.body.data.map((u: { email: string }) => u.email);
    expect(emails).toContain(tenantAAdmin.email);
    expect(emails).toContain(tenantAViewer.email);
    expect(emails).not.toContain(tenantBViewer.email);
  });

  it("keeps the full user list admin-only and gives other roles a names-only directory", async () => {
    const { user: viewer, password } = await createUserFixture(ctx.adminDataSource, tenantAId, {
      email: "tenantA-viewer-directory@test.dev",
      role: UserRole.VIEWER,
    });
    const token = await loginAs(viewer.email, password);

    await http().get("/users").set("Authorization", `Bearer ${token}`).expect(403);
    await http().get(`/users/${viewer.id}`).set("Authorization", `Bearer ${token}`).expect(403);

    const res = await http().get("/users/directory").set("Authorization", `Bearer ${token}`).expect(200);
    expect(res.body.data.map((u: { id: string }) => u.id)).toContain(viewer.id);
    for (const u of res.body.data) {
      expect(Object.keys(u).sort()).toEqual(["fullName", "id", "role", "status"]);
    }
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

    // Scoped by tenantId too, not just email — this user is created via the real
    // POST /users path (not createUserFixture, so not auto-uniquified), and email
    // uniqueness here is enforced per-tenant, not globally (same reasoning as bug
    // #16): an un-scoped findOne could silently pick up a same-literal-email row
    // from a different, stale tenant left over by a prior run of this same test.
    const created = await ctx.adminDataSource
      .getRepository(UserEntity)
      .findOne({ where: { email: "new-hire@test.dev", tenantId: tenantAId } });
    expect(created?.tenantId).toBe(tenantAId);
  });

  it("lets SUPER_ADMIN read across tenants only with X-Tenant-Override", async () => {
    const { user: superAdmin, password } = await createUserFixture(
      ctx.adminDataSource,
      platformTenantId,
      { email: "super-admin@test.dev", role: UserRole.SUPER_ADMIN },
    );
    const { user: tenantBOnly } = await createUserFixture(ctx.adminDataSource, tenantBId, {
      email: "tenantB-only@test.dev",
    });
    tenantBOnlyEmail = tenantBOnly.email;

    const token = await loginAs(superAdmin.email, password);

    const overrideRes = await http()
      .get("/users")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Tenant-Override", tenantBId)
      .expect(200);

    const overrideEmails = overrideRes.body.data.map((u: { email: string }) => u.email);
    expect(overrideEmails).toContain(tenantBOnly.email);
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
    expect(emails).toContain(superAdmin.email);
    // Relies on the previous test's tenantBOnlyEmail — without reading the real
    // (uniquified) value here, this assertion would trivially pass regardless of
    // actual behavior, since the bare literal never matches any row post-uniquification.
    expect(emails).not.toContain(tenantBOnlyEmail);
  });

  it("enforces RLS at the database level for direct SQL under the regops_app role", async () => {
    const appDataSource = new DataSource({
      type: "postgres",
      url: process.env.DATABASE_URL,
      entities: [UserEntity, TenantEntity],
    });
    await appDataSource.initialize();

    try {
      const { user: rlsTarget } = await createUserFixture(ctx.adminDataSource, tenantBId, {
        email: "rls-direct-target@test.dev",
      });

      const queryRunner = appDataSource.createQueryRunner();
      await queryRunner.connect();
      try {
        await queryRunner.query(
          `SELECT set_config('app.current_tenant_id', $1, true), set_config('app.bypass_rls', 'false', true)`,
          [tenantAId],
        );

        // Parameterized on the real (uniquified) email, not the bare literal — otherwise
        // this query would match zero rows regardless of whether RLS is actually working,
        // since the literal no longer equals anything post-uniquification. That would make
        // this assertion vacuously true rather than actually proving RLS hid the row.
        const rows = await queryRunner.query(`SELECT * FROM "user" WHERE email = $1`, [rlsTarget.email]);
        expect(rows).toHaveLength(0);
      } finally {
        await queryRunner.release();
      }
    } finally {
      await appDataSource.destroy();
    }
  });
});
