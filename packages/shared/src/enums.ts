export enum TenantType {
  MFB = "MFB",
  FINTECH = "FINTECH",
  PSP = "PSP",
  MMO = "MMO",
}

export enum TenantStatus {
  ACTIVE = "ACTIVE",
  SUSPENDED = "SUSPENDED",
  PENDING = "PENDING",
}

export enum UserRole {
  SUPER_ADMIN = "SUPER_ADMIN",
  TENANT_ADMIN = "TENANT_ADMIN",
  COMPLIANCE_OFFICER = "COMPLIANCE_OFFICER",
  INVESTIGATOR = "INVESTIGATOR",
  VIEWER = "VIEWER",
}

export enum UserStatus {
  ACTIVE = "ACTIVE",
  INVITED = "INVITED",
  SUSPENDED = "SUSPENDED",
}

/** Roles for which MFA enrollment is mandatory before full access is granted. */
export const MFA_MANDATORY_ROLES: readonly UserRole[] = [
  UserRole.SUPER_ADMIN,
  UserRole.TENANT_ADMIN,
  UserRole.COMPLIANCE_OFFICER,
];
