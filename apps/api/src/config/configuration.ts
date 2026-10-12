import { EnvConfig } from "./env.validation";

export default function configuration() {
  const env = process.env as unknown as EnvConfig;

  return {
    nodeEnv: env.NODE_ENV,
    port: Number(env.PORT),
    database: {
      url: env.DATABASE_URL,
      adminUrl: env.DATABASE_ADMIN_URL,
    },
    redis: {
      url: env.REDIS_URL,
    },
    jwt: {
      accessSecret: env.JWT_ACCESS_SECRET,
      accessTtl: env.JWT_ACCESS_TTL,
      refreshSecret: env.JWT_REFRESH_SECRET,
      refreshTtl: env.JWT_REFRESH_TTL,
    },
    corsOrigins: env.CORS_ORIGINS.split(",").map((origin) => origin.trim()),
    mfaIssuer: env.MFA_ISSUER,
    // Base of every invite / reset link. Falls back to the first allowed CORS origin, then to localhost
    // (main.ts warns in production when the result still points at localhost).
    frontendUrl: (env.FRONTEND_URL ?? env.CORS_ORIGINS.split(",")[0]?.trim() ?? "http://localhost:3000").replace(/\/+$/, ""),
    mail: {
      resendApiKey: env.RESEND_API_KEY,
      from: env.MAIL_FROM,
    },
  };
}

export type AppConfig = ReturnType<typeof configuration>;
