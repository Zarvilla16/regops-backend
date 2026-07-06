import request from "supertest";
import { authenticator } from "otplib";
import { UserRole } from "@regops/shared";
import { MfaService } from "../src/auth/mfa.service";
import {
  closeTestContext,
  createTenantFixture,
  createUserFixture,
  createTestContext,
  DEFAULT_TEST_PASSWORD,
  TestContext,
} from "./utils/test-app";

describe("Auth (e2e)", () => {
  let ctx: TestContext;
  let tenantId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    const tenant = await createTenantFixture(ctx.adminDataSource);
    tenantId = tenant.id;
  });

  afterAll(async () => {
    await closeTestContext(ctx);
  });

  const http = () => request(ctx.app.getHttpServer());

  it("logs in with valid credentials and returns access + refresh tokens", async () => {
    const { user, password } = await createUserFixture(ctx.adminDataSource, tenantId, {
      email: "valid-login@test.dev",
    });

    const res = await http()
      .post("/auth/login")
      .send({ email: user.email, password })
      .expect(200);

    expect(res.body.data.mfaRequired).toBe(false);
    expect(res.body.data.accessToken).toEqual(expect.any(String));
    expect(res.body.data.refreshToken).toEqual(expect.any(String));
  });

  it("rejects invalid credentials with 401", async () => {
    const { user } = await createUserFixture(ctx.adminDataSource, tenantId, {
      email: "invalid-login@test.dev",
    });

    const res = await http()
      .post("/auth/login")
      .send({ email: user.email, password: "wrong-password-entirely" })
      .expect(401);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("rejects login for a locked account with 423", async () => {
    const { user, password } = await createUserFixture(ctx.adminDataSource, tenantId, {
      email: "locked@test.dev",
      lockedUntil: new Date(Date.now() + 30 * 60 * 1000),
    });

    const res = await http()
      .post("/auth/login")
      .send({ email: user.email, password })
      .expect(423);

    expect(res.body.error.code).toBe("ACCOUNT_LOCKED");
  });

  it("rotates refresh tokens and revokes the old one on use", async () => {
    const { user, password } = await createUserFixture(ctx.adminDataSource, tenantId, {
      email: "refresh-rotation@test.dev",
    });

    const loginRes = await http()
      .post("/auth/login")
      .send({ email: user.email, password })
      .expect(200);
    const firstRefreshToken = loginRes.body.data.refreshToken;

    const refreshRes = await http()
      .post("/auth/refresh")
      .send({ refreshToken: firstRefreshToken })
      .expect(200);

    expect(refreshRes.body.data.accessToken).toEqual(expect.any(String));
    expect(refreshRes.body.data.refreshToken).toEqual(expect.any(String));
    expect(refreshRes.body.data.refreshToken).not.toBe(firstRefreshToken);

    // The old token was consumed by rotation — replaying it must now fail.
    await http().post("/auth/refresh").send({ refreshToken: firstRefreshToken }).expect(401);
  });

  it("revokes the entire chain when a revoked refresh token is replayed", async () => {
    const { user, password } = await createUserFixture(ctx.adminDataSource, tenantId, {
      email: "refresh-theft@test.dev",
    });

    const loginRes = await http()
      .post("/auth/login")
      .send({ email: user.email, password })
      .expect(200);
    const originalToken = loginRes.body.data.refreshToken;

    const rotatedRes = await http()
      .post("/auth/refresh")
      .send({ refreshToken: originalToken })
      .expect(200);
    const rotatedToken = rotatedRes.body.data.refreshToken;

    // Replay the already-rotated-away original token: theft indicator.
    const reuseRes = await http()
      .post("/auth/refresh")
      .send({ refreshToken: originalToken })
      .expect(401);
    expect(reuseRes.body.error.code).toBe("REFRESH_TOKEN_REUSED");

    // The legitimately-rotated-to token must also now be revoked (whole chain killed).
    await http().post("/auth/refresh").send({ refreshToken: rotatedToken }).expect(401);
  });

  it("challenges MFA-enabled users without issuing tokens, then completes login on verify-mfa", async () => {
    const mfaService = ctx.app.get(MfaService);
    const secret = mfaService.generateSecret();

    const { user, password } = await createUserFixture(ctx.adminDataSource, tenantId, {
      email: "mfa-user@test.dev",
      role: UserRole.COMPLIANCE_OFFICER,
      mfaEnabled: true,
      mfaSecret: mfaService.encryptSecret(secret),
    });

    const loginRes = await http()
      .post("/auth/login")
      .send({ email: user.email, password })
      .expect(200);

    expect(loginRes.body.data.mfaRequired).toBe(true);
    expect(loginRes.body.data.accessToken).toBeUndefined();
    expect(loginRes.body.data.mfaToken).toEqual(expect.any(String));

    const code = authenticator.generate(secret);
    const verifyRes = await http()
      .post("/auth/verify-mfa")
      .send({ mfaToken: loginRes.body.data.mfaToken, code })
      .expect(200);

    expect(verifyRes.body.data.accessToken).toEqual(expect.any(String));
    expect(verifyRes.body.data.refreshToken).toEqual(expect.any(String));
  });

  it("returns the current user from /auth/me when authenticated", async () => {
    const { user, password } = await createUserFixture(ctx.adminDataSource, tenantId, {
      email: "me-endpoint@test.dev",
    });

    const loginRes = await http()
      .post("/auth/login")
      .send({ email: user.email, password: password ?? DEFAULT_TEST_PASSWORD })
      .expect(200);

    const meRes = await http()
      .get("/auth/me")
      .set("Authorization", `Bearer ${loginRes.body.data.accessToken}`)
      .expect(200);

    expect(meRes.body.data.user.email).toBe(user.email);
    expect(meRes.body.data.user.id).toBe(user.id);
    expect(meRes.body.data.tenant.id).toBe(tenantId);
  });
});
