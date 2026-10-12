import { validateEnv } from "./env.validation";

const VALID_ENV = {
  DATABASE_URL: "postgres://regops_app:pw@localhost:5432/regops",
  DATABASE_ADMIN_URL: "postgres://regops_admin:pw@localhost:5432/regops",
  REDIS_URL: "redis://localhost:6379",
  JWT_ACCESS_SECRET: "a".repeat(64),
  JWT_REFRESH_SECRET: "b".repeat(64),
};

describe("validateEnv", () => {
  it("accepts a valid configuration and applies defaults", () => {
    const result = validateEnv(VALID_ENV);
    expect(result.NODE_ENV).toBe("development");
    expect(result.PORT).toBe(4000);
    expect(result.JWT_ACCESS_TTL).toBe("15m");
  });

  it("rejects a config missing required variables", () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
  });

  it("rejects secrets shorter than 64 characters", () => {
    expect(() =>
      validateEnv({ ...VALID_ENV, JWT_ACCESS_SECRET: "too-short" }),
    ).toThrow(/JWT_ACCESS_SECRET/);
  });

  it("mail settings are optional and default sensibly", () => {
    const result = validateEnv(VALID_ENV);
    expect(result.RESEND_API_KEY).toBeUndefined();
    expect(result.FRONTEND_URL).toBeUndefined();
    expect(result.MAIL_FROM).toMatch(/RegOps/);
  });

  it("rejects a FRONTEND_URL that is not a URL", () => {
    expect(() => validateEnv({ ...VALID_ENV, FRONTEND_URL: "not a url" })).toThrow(/FRONTEND_URL/);
  });

  it("rejects identical access and refresh secrets", () => {
    expect(() =>
      validateEnv({ ...VALID_ENV, JWT_REFRESH_SECRET: VALID_ENV.JWT_ACCESS_SECRET }),
    ).toThrow(/JWT_REFRESH_SECRET must differ/);
  });
});
