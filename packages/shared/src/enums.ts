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

// --- Screening (Backend Prompt 3) ------------------------------------------

export enum ScreeningProviderName {
  SMILE_ID = "SMILE_ID",
  PREMBLY = "PREMBLY",
  MOCK = "MOCK",
}

export enum ScreeningCheckType {
  SANCTIONS = "SANCTIONS",
  PEP = "PEP",
  ADVERSE_MEDIA = "ADVERSE_MEDIA",
}

export enum ScreeningCheckStatus {
  PENDING = "PENDING",
  COMPLETED = "COMPLETED",
  FAILED = "FAILED",
  TIMEOUT = "TIMEOUT",
}

/** Named ScreeningResultType (not just "ScreeningResult") since that name is
 * reserved for the richer provider-call return shape in screening-engine. */
export enum ScreeningResultType {
  CLEAN = "CLEAN",
  POTENTIAL_MATCH = "POTENTIAL_MATCH",
  CONFIRMED_MATCH = "CONFIRMED_MATCH",
  ERROR = "ERROR",
}

export enum ScreeningTrigger {
  ONBOARDING = "ONBOARDING",
  SCHEDULED = "SCHEDULED",
  MANUAL = "MANUAL",
  UPDATE = "UPDATE",
}

export enum MatchReviewStatus {
  PENDING_REVIEW = "PENDING_REVIEW",
  REVIEWED = "REVIEWED",
}

export enum MatchDecision {
  TRUE_POSITIVE = "TRUE_POSITIVE",
  FALSE_POSITIVE = "FALSE_POSITIVE",
}
