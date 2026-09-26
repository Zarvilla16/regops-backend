import {
  AccountStatus,
  AccountType,
  AlertCloseCategory,
  AlertSeverity,
  AlertStatus,
  CasePriority,
  CaseStatus,
  CustomerStatus,
  CustomerType,
  IngestionBatchStatus,
  MatchDecision,
  MatchReviewStatus,
  PepCategory,
  PepStatus,
  ReportStatus,
  ReportType,
  RiskFactorType,
  RiskLevel,
  RuleAction,
  RuleEvaluationResultStatus,
  RuleReplayStatus,
  RuleScenarioType,
  ScoreTrigger,
  ScreeningCheckStatus,
  ScreeningCheckType,
  ScreeningProviderName,
  ScreeningResultType,
  ScreeningTrigger,
  TenantStatus,
  TenantType,
  TransactionChannel,
  TransactionSource,
  TransactionType,
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

// --- Transactions (Backend Prompt 4) ----------------------------------------

export interface TransactionDto {
  id: string;
  tenantId: string;
  cbsTransactionId: string;
  customerId: string;
  accountNumber: string;
  amount: string;
  currency: string;
  type: TransactionType;
  channel: TransactionChannel;
  counterpartyAccount: string | null;
  counterpartyBank: string | null;
  counterpartyName: string | null;
  counterpartyCustomerId: string | null;
  narration: string | null;
  reference: string | null;
  balanceAfter: string | null;
  occurredAt: string;
  ingestedAt: string;
  source: TransactionSource;
  ingestionBatchId: string | null;
}

export interface CustomerAccountDto {
  id: string;
  tenantId: string;
  customerId: string;
  accountNumber: string;
  accountType: AccountType;
  accountName: string | null;
  status: AccountStatus;
  balance: string | null;
  balanceAsOf: string | null;
  openedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IngestionBatchDto {
  id: string;
  tenantId: string;
  source: TransactionSource;
  sourceReference: string | null;
  status: IngestionBatchStatus;
  totalRows: number;
  processedRows: number;
  succeededRows: number;
  failedRows: number;
  errorReportUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

/** Debug view backing GET /customers/:id/velocity-stats (spec Section 10) —
 * the raw sub-signal inputs TransactionVelocityAdapter computed, not just
 * the final contributed score, so a COMPLIANCE_OFFICER can see *why*. */
export interface VelocityStatsDto {
  customerId: string;
  score: number;
  detail: Record<string, unknown>;
}

// --- Rules & Alerts (Backend Prompt 5) --------------------------------------

export interface RuleDto {
  id: string;
  tenantId: string;
  name: string;
  scenarioType: RuleScenarioType;
  description: string | null;
  config: Record<string, unknown>;
  severity: AlertSeverity;
  action: RuleAction;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AlertDto {
  id: string;
  tenantId: string;
  ruleId: string;
  customerId: string;
  triggeringTransactionId: string | null;
  scenarioType: RuleScenarioType;
  severity: AlertSeverity;
  status: AlertStatus;
  title: string;
  evidence: Record<string, unknown>;
  dedupKey: string;
  fireCount: number;
  firstFiredAt: string;
  lastFiredAt: string;
  assignedTo: string | null;
  closedAt: string | null;
  closedBy: string | null;
  closeCategory: AlertCloseCategory | null;
  closureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RuleEvaluationDto {
  id: string;
  tenantId: string;
  ruleId: string;
  transactionId: string | null;
  evaluatedAt: string;
  durationMs: number;
  result: RuleEvaluationResultStatus;
  alertId: string | null;
  errorMessage: string | null;
}

export interface RuleReplayDto {
  id: string;
  tenantId: string;
  ruleId: string | null;
  fromDate: string;
  toDate: string;
  dryRun: boolean;
  status: RuleReplayStatus;
  totalTransactions: number;
  processedTransactions: number;
  firedCount: number;
  reportKey: string | null;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
}

// --- Case Management (Backend Prompt 6) -------------------------------------

export interface CaseDto {
  id: string;
  tenantId: string;
  caseNumber: string;
  customerId: string;
  status: CaseStatus;
  priority: CasePriority;
  assignedTo: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  submittedBy: string | null;
  submittedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  escalationRationale: string | null;
  closedAt: string | null;
  closedBy: string | null;
  closureReason: string | null;
}

/** Same field set as CustomerDto's subset used by withCaseSummary in the mock. */
export interface CaseCustomerSummaryDto {
  id: string;
  fullName: string;
  photoUrl: string | null;
  riskLevel: RiskLevel;
  riskScore: number;
  kycTier: number;
  lastScreenedAt: string | null;
  lastRiskCalculatedAt: string | null;
  isPep: boolean;
  isSanctioned: boolean;
}

export interface CaseAlertSummaryDto {
  id: string;
  title: string;
  severity: AlertSeverity;
  status: AlertStatus;
  scenario: RuleScenarioType;
}

export interface CaseNoteDto {
  id: string;
  caseId: string;
  userId: string;
  content: string;
  createdAt: string;
}

export interface CaseEvidenceDto {
  id: string;
  caseId: string;
  fileName: string;
  fileType: string;
  fileSizeBytes: number;
  uploadedBy: string;
  createdAt: string;
}

export interface CaseChecklistItemDto {
  key: "ALERT_REVIEWED" | "NOTE_ADDED" | "TRANSACTIONS_REVIEWED" | "RISK_SCORE_CURRENT";
  label: string;
  passed: boolean;
}

export interface CaseChecklistDto {
  items: CaseChecklistItemDto[];
  complete: boolean;
}

/** `type` distinguishes timeline entries for the frontend without string-matching `text` — see
 * CaseTimelineService for the exact set of types produced (opened, reassigned, note, evidence,
 * alert_linked, transaction, submitted, approved, rejected, closed, sar_filed). */
export interface CaseTimelineEventDto {
  type: string;
  at: string;
  actor: string;
  text: string;
}

export interface CaseReportSummaryDto {
  id: string;
  status: ReportStatus;
}

export interface CaseDetailDto extends CaseDto {
  customer: CaseCustomerSummaryDto | null;
  alerts: CaseAlertSummaryDto[];
  notes: CaseNoteDto[];
  evidence: CaseEvidenceDto[];
  transactions: TransactionDto[];
  timeline: CaseTimelineEventDto[];
  checklist: CaseChecklistDto;
  report: CaseReportSummaryDto | null;
}

export interface CaseListItemDto {
  id: string;
  caseNumber: string;
  customer: CaseCustomerSummaryDto | null;
  status: CaseStatus;
  priority: CasePriority;
  assignedTo: string | null;
  alertCount: number;
  createdAt: string;
}

export interface ReportDto {
  id: string;
  tenantId: string;
  /** Set iff reportType = SAR. */
  caseId: string | null;
  /** Set iff reportType = CTR. */
  transactionId: string | null;
  customerId: string;
  reportType: ReportType;
  status: ReportStatus;
  flaggedAmount: number | null;
  narrative: string | null;
  generatedAt: string;
  /** null = system-generated (every CTR). */
  generatedBy: string | null;
  submittedBy: string | null;
  submittedAt: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  nfiuReference: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReportCaseSummaryDto {
  id: string;
  caseNumber: string;
  status: CaseStatus;
  escalationRationale: string | null;
}

export interface ReportTransactionSummaryDto {
  id: string;
  cbsTransactionId: string;
  accountNumber: string;
  amount: string;
  currency: string;
  channel: TransactionChannel;
  type: TransactionType;
  occurredAt: string;
}

export interface ReportDetailDto extends ReportDto {
  customer: CaseCustomerSummaryDto | null;
  /** Populated for SAR only. */
  case: ReportCaseSummaryDto | null;
  /** Populated for CTR only. */
  transaction: ReportTransactionSummaryDto | null;
}
