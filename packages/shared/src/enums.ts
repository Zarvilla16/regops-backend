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

export enum CustomerType {
  INDIVIDUAL = "INDIVIDUAL",
  SME = "SME",
  CORPORATE = "CORPORATE",
  NGO = "NGO",
  GOVERNMENT = "GOVERNMENT",
  PEP = "PEP",
}

export enum CustomerStatus {
  ACTIVE = "ACTIVE",
  DORMANT = "DORMANT",
  BLOCKED = "BLOCKED",
  CLOSED = "CLOSED",
}

export enum RiskLevel {
  LOW = "LOW",
  MEDIUM = "MEDIUM",
  HIGH = "HIGH",
  CRITICAL = "CRITICAL",
}

/** What caused a risk score to be (re)calculated — recorded on every RiskScoreHistory row. */
export enum ScoreTrigger {
  INITIAL = "INITIAL",
  SCHEDULED = "SCHEDULED",
  MANUAL = "MANUAL",
  SCREENING_MATCH = "SCREENING_MATCH",
  CUSTOMER_UPDATED = "CUSTOMER_UPDATED",
}

/** Which discrete RiskFactor implementation a RiskFactorConfig row tunes. */
export enum RiskFactorType {
  CUSTOMER_TYPE = "CUSTOMER_TYPE",
  OCCUPATION = "OCCUPATION",
  COUNTRY = "COUNTRY",
  PRODUCT_MIX = "PRODUCT_MIX",
  TRANSACTION_VELOCITY = "TRANSACTION_VELOCITY",
  KYC_TIER = "KYC_TIER",
}
