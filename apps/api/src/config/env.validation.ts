import { z } from "zod";

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_ADMIN_URL: z.string().min(1, "DATABASE_ADMIN_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),

  JWT_ACCESS_SECRET: z.string().min(64, "JWT_ACCESS_SECRET must be at least 64 characters"),
  JWT_ACCESS_TTL: z.string().default("15m"),
  JWT_REFRESH_SECRET: z.string().min(64, "JWT_REFRESH_SECRET must be at least 64 characters"),
  JWT_REFRESH_TTL: z.string().default("30d"),

  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  MFA_ISSUER: z.string().default("RegOps"),

  /** Public base URL of the console; used to build the links in invite / password-reset e-mails. */
  FRONTEND_URL: z.string().url().optional(),
  /** Resend API key. Unset = no mail is sent (logged in development, warned in production). */
  RESEND_API_KEY: z.string().min(1).optional(),
  MAIL_FROM: z.string().min(3).default("RegOps <no-reply@regops.local>"),
});

export type EnvConfig = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): EnvConfig {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  if (parsed.data.JWT_ACCESS_SECRET === parsed.data.JWT_REFRESH_SECRET) {
    throw new Error(
      "Invalid environment configuration:\nJWT_REFRESH_SECRET must differ from JWT_ACCESS_SECRET",
    );
  }

  return parsed.data;
}
