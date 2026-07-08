import {
  CustomerStatus,
  CustomerType,
  RiskFactorType,
  RiskLevel,
  ScoreTrigger,
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
  onboardedAt: string;
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
