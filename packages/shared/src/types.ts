import {
  CustomerStatus,
  CustomerType,
  MatchDecision,
  MatchReviewStatus,
  PepCategory,
  PepStatus,
  RiskFactorType,
  RiskLevel,
  ScoreTrigger,
  ScreeningCheckStatus,
  ScreeningCheckType,
  ScreeningProviderName,
  ScreeningResultType,
  ScreeningTrigger,
  TenantStatus,
  TenantType,
  UserRole,
  UserStatus,
} from "./enums";

export interface ApiErrorShape {
  code: string;
  message: string;
  details?: unknown;
}

export interface ApiErrorResponse {
  success: false;
  error: ApiErrorShape;
}

export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

export interface TenantDto {
  id: string;
  name: string;
  type: TenantType;
  cbnLicenseNumber: string | null;
  status: TenantStatus;
  createdAt: string;
  updatedAt: string;
}

export interface UserDto {
  id: string;
  tenantId: string;
  email: string;
  fullName: string;
  role: UserRole;
  status: UserStatus;
  mfaEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuthUserContext {
  sub: string;
  tenantId: string;
  role: UserRole;
  email: string;
}

export interface LoginResponseDto {
  mfaRequired: boolean;
  mfaToken?: string;
  accessToken?: string;
  refreshToken?: string;
  user?: UserDto;
}

export interface CurrentUserResponseDto {
  user: UserDto;
  tenant: Pick<TenantDto, "id" | "name"> | null;
}

/**
 * Wire shape for both the masked (default) and full-PII (GET /customers/:id/pii)
 * customer responses — they're the same shape, `bvn`/`nin` just carry a masked
 * vs. unmasked string depending on which endpoint produced it.
 */
export interface CustomerDto {
  id: string;
  tenantId: string;
  cbsCustomerId: string;
  bvn: string | null;
  nin: string | null;
  fullName: string;
  email: string | null;
  phone: string | null;
  dateOfBirth: string | null;
  customerType: CustomerType;
  occupation: string | null;
  country: string;
  nationality: string | null;
  kycTier: number;
  riskScore: number;
  riskLevel: RiskLevel;
  lastRiskCalculatedAt: string | null;
  isPep: boolean;
  isSanctioned: boolean;
  lastScreenedAt: string | null;
  status: CustomerStatus;
  /** FileStorage key, not a literal browsable URL (LocalFileStorage.getSignedDownloadUrl
   * always returns null in local dev) — fetch the actual bytes via GET /customers/:id/photo. */
  photoUrl: string | null;
  onboardedAt: string;
  createdAt: string;
  updatedAt: string;
}

/** One-to-one with Customer, only populated when isPep is true (Backend Prompt 3.5, Section 1). */
export interface PepDetailsDto {
  id: string;
  customerId: string;
  tenantId: string;
  pepCategory: PepCategory;
  pepPosition: string;
  pepInstitution: string;
  pepCountry: string;
  pepStatus: PepStatus;
  pepStartDate: string;
  pepEndDate: string | null;
  isPepByAssociation: boolean;
  associatedPepName: string | null;
  sourceOfWealth: string;
  eddApprovedBy: string | null;
  eddApprovedAt: string | null;
  nextReviewDate: string;
  createdAt: string;
  updatedAt: string;
}

export interface RiskScoreHistoryDto {
  id: string;
  tenantId: string;
  customerId: string;
  score: number;
  level: RiskLevel;
  factors: Record<string, unknown>;
  trigger: ScoreTrigger;
  previousScore: number | null;
  previousLevel: RiskLevel | null;
  calculatedAt: string;
  calculatedBy: string | null;
}

export interface RiskFactorConfigDto {
  id: string;
  tenantId: string;
  factorType: RiskFactorType;
  weight: number;
  config: Record<string, unknown>;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BatchIngestJobStatusDto {
  jobId: string;
  status: "queued" | "active" | "completed" | "failed";
  progress: number;
  total: number | null;
  succeeded: number | null;
  failed: number | null;
  errorReportUrl: string | null;
}

// --- Screening (Backend Prompt 3) ------------------------------------------

export interface ScreeningCheckDto {
  id: string;
  tenantId: string;
  customerId: string | null;
  checkType: ScreeningCheckType;
  provider: ScreeningProviderName;
  inputData: Record<string, unknown>;
  status: ScreeningCheckStatus;
  result: ScreeningResultType | null;
  highestMatchScore: number | null;
  providerReference: string | null;
  rawResponse: unknown;
  errorMessage: string | null;
  latencyMs: number | null;
  trigger: ScreeningTrigger;
  triggeredBy: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface ScreeningMatchDto {
  id: string;
  tenantId: string;
  screeningCheckId: string;
  /** Denormalized from the parent ScreeningCheck at read time — a reviewer
   * needs to know at a glance whether this is a SANCTIONS/PEP/ADVERSE_MEDIA
   * hit, not just an opaque screeningCheckId to resolve separately. */
  checkType: ScreeningCheckType;
  /** Nullable, matching ScreeningCheckDto.customerId's precedent: the
   * synchronous sanctions pre-screen at onboarding (Section 5.1) runs before
   * a Customer row exists, so a match tied to a blocked attempt genuinely
   * has no customer to reference — never coerce this to "" (an invalid,
   * misleading stand-in for "no customer"). */
  customerId: string | null;
  listSource: string;
  matchName: string;
  matchScore: number;
  matchData: Record<string, unknown>;
  reviewStatus: MatchReviewStatus;
  decision: MatchDecision | null;
  decisionReason: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

/**
 * credentialsRef/config are deliberately NOT part of this wire DTO — a
 * provider's vault/env secret reference should never round-trip to a client,
 * even a TENANT_ADMIN one (see Section 7.4's "never plaintext" instruction,
 * extended here to "never even the ref, to any client").
 */
export interface ScreeningProviderConfigDto {
  id: string;
  tenantId: string;
  provider: ScreeningProviderName;
  checkType: ScreeningCheckType;
  isPrimary: boolean;
  isFallback: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
