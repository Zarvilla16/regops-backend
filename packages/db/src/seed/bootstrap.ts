import "reflect-metadata";
import * as dotenv from "dotenv";
import * as argon2 from "argon2";
import { AppDataSource } from "../data-source";
import { TenantEntity } from "../entities/tenant.entity";
import { UserEntity } from "../entities/user.entity";
import { TenantStatus, TenantType, UserRole, UserStatus } from "@regops/shared";

dotenv.config();

/**
 * Production bootstrap: creates the internal platform tenant and ONE Super Admin, from env vars only.
 * No demo tenants, no default credentials. Idempotent — if a Super Admin already exists on the platform
 * tenant it does nothing (it never resets a password). Further tenants and users are created through the API.
 *
 *   BOOTSTRAP_SUPER_ADMIN_EMAIL     required
 *   BOOTSTRAP_SUPER_ADMIN_PASSWORD  required, at least 12 characters
 *   BOOTSTRAP_SUPER_ADMIN_NAME      optional, defaults to "Platform Super Admin"
 *
 * Runs as the admin role (DATABASE_ADMIN_URL), which bypasses RLS.
 */
const MIN_PASSWORD_LENGTH = 12;

async function bootstrap(): Promise<void> {
  const email = process.env.BOOTSTRAP_SUPER_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.BOOTSTRAP_SUPER_ADMIN_PASSWORD;
  const fullName = process.env.BOOTSTRAP_SUPER_ADMIN_NAME?.trim() || "Platform Super Admin";

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("BOOTSTRAP_SUPER_ADMIN_EMAIL is required and must be a valid email");
  }
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`BOOTSTRAP_SUPER_ADMIN_PASSWORD is required and must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }

  await AppDataSource.initialize();
  try {
    const tenantRepo = AppDataSource.getRepository(TenantEntity);
    const userRepo = AppDataSource.getRepository(UserEntity);

    let platformTenant = await tenantRepo.findOne({ where: { name: "RegOps Platform" } });
    if (!platformTenant) {
      platformTenant = await tenantRepo.save(
        tenantRepo.create({
          name: "RegOps Platform",
          type: TenantType.FINTECH,
          status: TenantStatus.ACTIVE,
          config: { internal: true },
        }),
      );
      console.log(`Created platform tenant ${platformTenant.id}`);
    }

    const existing = await userRepo.findOne({
      where: { tenantId: platformTenant.id, role: UserRole.SUPER_ADMIN },
      withDeleted: true,
    });
    if (existing) {
      console.log(`A Super Admin already exists (${existing.email}); nothing to do.`);
      return;
    }

    await userRepo.save(
      userRepo.create({
        tenantId: platformTenant.id,
        email,
        passwordHash: await argon2.hash(password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3 }),
        fullName,
        role: UserRole.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
      }),
    );
    console.log(`Created Super Admin ${email}`);
  } finally {
    await AppDataSource.destroy();
  }
}

bootstrap().catch((err) => {
  console.error("Bootstrap failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
