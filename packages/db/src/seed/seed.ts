import "reflect-metadata";
import * as dotenv from "dotenv";
import * as argon2 from "argon2";
import { AppDataSource } from "../data-source";
import { TenantEntity } from "../entities/tenant.entity";
import { UserEntity } from "../entities/user.entity";
import { TenantStatus, TenantType, UserRole, UserStatus } from "@regops/shared";

dotenv.config();

const SUPER_ADMIN_EMAIL = process.env.SEED_SUPER_ADMIN_EMAIL ?? "superadmin@regops.dev";
const SUPER_ADMIN_PASSWORD = process.env.SEED_SUPER_ADMIN_PASSWORD ?? "SuperAdmin!2026";
const TENANT_ADMIN_PASSWORD = process.env.SEED_TENANT_ADMIN_PASSWORD ?? "TenantAdmin!2026";
const COMPLIANCE_OFFICER_PASSWORD =
  process.env.SEED_COMPLIANCE_OFFICER_PASSWORD ?? "Compliance!2026";

const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
};

async function hash(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

/**
 * Seeding runs as regops_admin (BYPASSRLS), so no tenant session var needs to
 * be set here — RLS only constrains the regops_app role used by the API.
 */
async function seed(): Promise<void> {
  await AppDataSource.initialize();

  const tenantRepo = AppDataSource.getRepository(TenantEntity);
  const userRepo = AppDataSource.getRepository(UserEntity);

  // --- Platform-level super admin (tenant_id still required by schema, so a
  // dedicated internal "platform" tenant houses it). ---
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
    console.log(`Created platform tenant: ${platformTenant.id}`);
  }

  let superAdmin = await userRepo.findOne({
    where: { tenantId: platformTenant.id, email: SUPER_ADMIN_EMAIL },
  });
  if (!superAdmin) {
    superAdmin = await userRepo.save(
      userRepo.create({
        tenantId: platformTenant.id,
        email: SUPER_ADMIN_EMAIL,
        passwordHash: await hash(SUPER_ADMIN_PASSWORD),
        fullName: "RegOps Super Admin",
        role: UserRole.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
      }),
    );
    console.log(`Created SUPER_ADMIN: ${SUPER_ADMIN_EMAIL}`);
  }

  // --- Demo tenant ---
  let demoTenant = await tenantRepo.findOne({ where: { name: "Demo MFB Limited" } });
  if (!demoTenant) {
    demoTenant = await tenantRepo.save(
      tenantRepo.create({
        name: "Demo MFB Limited",
        type: TenantType.MFB,
        cbnLicenseNumber: "CBN-MFB-DEMO-0001",
        status: TenantStatus.ACTIVE,
      }),
    );
    console.log(`Created demo tenant: ${demoTenant.id}`);
  }

  const demoTenantAdminEmail = "admin@demomfb.dev";
  let tenantAdmin = await userRepo.findOne({
    where: { tenantId: demoTenant.id, email: demoTenantAdminEmail },
  });
  if (!tenantAdmin) {
    tenantAdmin = await userRepo.save(
      userRepo.create({
        tenantId: demoTenant.id,
        email: demoTenantAdminEmail,
        passwordHash: await hash(TENANT_ADMIN_PASSWORD),
        fullName: "Demo Tenant Admin",
        role: UserRole.TENANT_ADMIN,
        status: UserStatus.ACTIVE,
      }),
    );
    console.log(`Created TENANT_ADMIN: ${demoTenantAdminEmail}`);
  }

  const demoComplianceEmail = "compliance@demomfb.dev";
  let complianceOfficer = await userRepo.findOne({
    where: { tenantId: demoTenant.id, email: demoComplianceEmail },
  });
  if (!complianceOfficer) {
    complianceOfficer = await userRepo.save(
      userRepo.create({
        tenantId: demoTenant.id,
        email: demoComplianceEmail,
        passwordHash: await hash(COMPLIANCE_OFFICER_PASSWORD),
        fullName: "Demo Compliance Officer",
        role: UserRole.COMPLIANCE_OFFICER,
        status: UserStatus.ACTIVE,
      }),
    );
    console.log(`Created COMPLIANCE_OFFICER: ${demoComplianceEmail}`);
  }

  console.log("\nSeed complete. Credentials:");
  console.table([
    { role: "SUPER_ADMIN", email: SUPER_ADMIN_EMAIL, password: SUPER_ADMIN_PASSWORD },
    { role: "TENANT_ADMIN", email: demoTenantAdminEmail, password: TENANT_ADMIN_PASSWORD },
    {
      role: "COMPLIANCE_OFFICER",
      email: demoComplianceEmail,
      password: COMPLIANCE_OFFICER_PASSWORD,
    },
  ]);

  await AppDataSource.destroy();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
