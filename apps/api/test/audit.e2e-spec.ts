import request from "supertest";
import { DataSource } from "typeorm";
import { AuditLogEntity, TenantEntity, UserEntity } from "@regops/db";
import { UserRole } from "@regops/shared";
import {
  closeTestContext,
  createTenantFixture,
  createUserFixture,
  createTestContext,
  TestContext,
} from "./utils/test-app";

describe("Audit logging (e2e)", () => {
  let ctx: TestContext;
  let tenantId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    tenantId = (await createTenantFixture(ctx.adminDataSource)).id;
  });

  afterAll(async () => {
    await closeTestContext(ctx);
  });

  const http = () => request(ctx.app.getHttpServer());

  async function loginAs(email: string, password: string): Promise<string> {
    const res = await http().post("/auth/login").send({ email, password }).expect(200);
    return res.body.data.accessToken;
  }

  async function latestAuditLog(action: string, entityId: string) {
    return ctx.adminDataSource
      .getRepository(AuditLogEntity)
      .createQueryBuilder("audit_log")
      .where("audit_log.action = :action", { action })
      .andWhere("audit_log.entity_id = :entityId", { entityId })
      .orderBy("audit_log.created_at", "DESC")
      .getOne();
  }

  it("writes an audit entry with after_state when a user is created", async () => {
    const { user: admin, password } = await createUserFixture(ctx.adminDataSource, tenantId, {
      email: "audit-admin@test.dev",
      role: UserRole.TENANT_ADMIN,
    });
    const token = await loginAs(admin.email, password);

    const createRes = await http()
      .post("/users")
      .set("Authorization", `Bearer ${token}`)
      .send({
        email: "audit-created@test.dev",
        password: "SomeStrongPassword123",
        fullName: "Audit Created",
        role: UserRole.VIEWER,
      })
      .expect(201);

    const newUserId = createRes.body.data.id;
    const log = await latestAuditLog("user.create", newUserId);

    expect(log).toBeTruthy();
    expect(log?.afterState).toMatchObject({ email: "audit-created@test.dev" });
    expect(log?.beforeState).toBeNull();
  });

  it("writes an audit entry with before_state and after_state when a user is updated", async () => {
    const { user: admin, password } = await createUserFixture(ctx.adminDataSource, tenantId, {
      email: "audit-admin-2@test.dev",
      role: UserRole.TENANT_ADMIN,
    });
    const { user: target } = await createUserFixture(ctx.adminDataSource, tenantId, {
      email: "audit-update-target@test.dev",
      fullName: "Original Name",
    });
    const token = await loginAs(admin.email, password);

    await http()
      .patch(`/users/${target.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ fullName: "Updated Name" })
      .expect(200);

    const log = await latestAuditLog("user.update", target.id);

    expect(log?.beforeState).toMatchObject({ fullName: "Original Name" });
    expect(log?.afterState).toMatchObject({ fullName: "Updated Name" });
  });

  it("audit-logs failed login attempts", async () => {
    const { user } = await createUserFixture(ctx.adminDataSource, tenantId, {
      email: "audit-failed-login@test.dev",
    });

    await http()
      .post("/auth/login")
      .send({ email: user.email, password: "definitely-wrong" })
      .expect(401);

    const log = await latestAuditLog("user.login.failed", user.id);
    expect(log).toBeTruthy();
  });

  it("never persists password_hash, mfa_secret, or refresh tokens in audit state", async () => {
    const { user: admin, password } = await createUserFixture(ctx.adminDataSource, tenantId, {
      email: "audit-admin-3@test.dev",
      role: UserRole.TENANT_ADMIN,
    });
    const token = await loginAs(admin.email, password);

    const createRes = await http()
      .post("/users")
      .set("Authorization", `Bearer ${token}`)
      .send({
        email: "audit-sensitive@test.dev",
        password: "SomeStrongPassword123",
        fullName: "Audit Sensitive",
        role: UserRole.VIEWER,
      })
      .expect(201);

    const log = await latestAuditLog("user.create", createRes.body.data.id);
    const serialized = JSON.stringify(log?.afterState ?? {});

    expect(serialized).not.toMatch(/passwordHash/i);
    expect(serialized).not.toMatch(/mfaSecret/i);
    expect(serialized).not.toMatch(/tokenHash/i);
    expect(serialized).not.toContain("SomeStrongPassword123");
  });

  it("rejects direct UPDATE and DELETE on audit_log under the regops_app role", async () => {
    const appDataSource = new DataSource({
      type: "postgres",
      url: process.env.DATABASE_URL,
      entities: [UserEntity, AuditLogEntity, TenantEntity],
    });
    await appDataSource.initialize();

    try {
      const queryRunner = appDataSource.createQueryRunner();
      await queryRunner.connect();
      try {
        await queryRunner.query(
          `SELECT set_config('app.current_tenant_id', $1, true), set_config('app.bypass_rls', 'true', true)`,
          [tenantId],
        );

        await expect(
          queryRunner.query(`UPDATE audit_log SET action = 'tampered' WHERE tenant_id = $1`, [
            tenantId,
          ]),
        ).rejects.toThrow(/permission denied/i);

        await expect(
          queryRunner.query(`DELETE FROM audit_log WHERE tenant_id = $1`, [tenantId]),
        ).rejects.toThrow(/permission denied/i);
      } finally {
        await queryRunner.release();
      }
    } finally {
      await appDataSource.destroy();
    }
  });
});
