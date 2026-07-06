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
  };
}

export type AppConfig = ReturnType<typeof configuration>;
