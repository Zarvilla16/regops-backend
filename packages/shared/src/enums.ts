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
  /** Set only by CustomersService.create() when the new customer is a PEP
   * (Backend Prompt 3.5, Section 2) — the Customer row exists (so
   * screening/audit can reference it) but isn't treated as fully onboarded
   * until POST /customers/:id/approve-pep transitions it to ACTIVE. Not
   * directly settable via PATCH /customers/:id — see CustomersService.update. */
  PENDING_EDD_APPROVAL = "PENDING_EDD_APPROVAL",
  /** Set only by the transaction ingestion pipeline's auto_create_stub mode
   * (Backend Prompt 4, Section 5.6) — a Customer row created solely because
   * an incoming transaction referenced an unknown cbs_customer_id, so
   * something can reference it, but real KYC onboarding hasn't happened yet. */
  PENDING_KYC = "PENDING_KYC",
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
  /** transaction.ingested, debounced 60s per customer (Backend Prompt 4, Section 9.4). */
  TRANSACTION_ACTIVITY = "TRANSACTION_ACTIVITY",
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
  /** Counterparty screening for the HIGH_RISK_COUNTERPARTY rule (Backend
   * Prompt 5, Section 6.4) — added to screening_trigger_enum via
   * RulesAndAlerts1700000050000's ALTER TYPE ADD VALUE. */
  TRANSACTION_MONITORING = "TRANSACTION_MONITORING",
}

export enum MatchReviewStatus {
  PENDING_REVIEW = "PENDING_REVIEW",
  REVIEWED = "REVIEWED",
}

export enum MatchDecision {
  TRUE_POSITIVE = "TRUE_POSITIVE",
  FALSE_POSITIVE = "FALSE_POSITIVE",
}

// --- Customer module enhancements (Backend Prompt 3.5) ---------------------

export enum PepCategory {
  DOMESTIC = "DOMESTIC",
  FOREIGN = "FOREIGN",
  INTERNATIONAL_ORG = "INTERNATIONAL_ORG",
}

/** null pepEndDate means still current — pepStatus is a separate, explicit
 * field rather than derived from that, since a FORMER PEP's monitoring
 * obligations (Section 1) don't reduce to "has an end date". */
export enum PepStatus {
  CURRENT = "CURRENT",
  FORMER = "FORMER",
}

// --- Transactions (Backend Prompt 4) ----------------------------------------

export enum TransactionType {
  CREDIT = "CREDIT",
  DEBIT = "DEBIT",
}

export enum TransactionChannel {
  BRANCH = "BRANCH",
  MOBILE = "MOBILE",
  USSD = "USSD",
  POS = "POS",
  AGENT = "AGENT",
  TRANSFER = "TRANSFER",
  CASH = "CASH",
  CARD = "CARD",
  ATM = "ATM",
  API = "API",
  OTHER = "OTHER",
}

/** Also used as IngestionBatch.source — every batch's rows share one origin. */
export enum TransactionSource {
  SFTP = "SFTP",
  WEBHOOK = "WEBHOOK",
  MANUAL = "MANUAL",
  BACKFILL = "BACKFILL",
}

export enum AccountType {
  SAVINGS = "SAVINGS",
  CURRENT = "CURRENT",
  LOAN = "LOAN",
  FIXED_DEPOSIT = "FIXED_DEPOSIT",
  WALLET = "WALLET",
  OTHER = "OTHER",
}

export enum AccountStatus {
  ACTIVE = "ACTIVE",
  DORMANT = "DORMANT",
  BLOCKED = "BLOCKED",
  CLOSED = "CLOSED",
}

export enum IngestionBatchStatus {
  QUEUED = "QUEUED",
  PROCESSING = "PROCESSING",
  COMPLETED = "COMPLETED",
  COMPLETED_WITH_ERRORS = "COMPLETED_WITH_ERRORS",
  FAILED = "FAILED",
}

/**
 * Governs how IngestionService resolves a row's customer_cbs_id (spec
 * Section 5.6). `buffer` (side-table + later linking) is explicitly v2 in
 * the spec and is not implemented — tenants must be in `reject` or
 * `auto_create_stub` mode.
 */
export enum UnknownCustomerMode {
  REJECT = "REJECT",
  AUTO_CREATE_STUB = "AUTO_CREATE_STUB",
}

// --- Rules & Alerts (Backend Prompt 5) --------------------------------------

export enum RuleScenarioType {
  LARGE_CASH = "LARGE_CASH",
  STRUCTURING = "STRUCTURING",
  RAPID_INFLOW_OUTFLOW = "RAPID_INFLOW_OUTFLOW",
  HIGH_RISK_COUNTERPARTY = "HIGH_RISK_COUNTERPARTY",
  VELOCITY_SPIKE = "VELOCITY_SPIKE",
}

export enum AlertSeverity {
  LOW = "LOW",
  MEDIUM = "MEDIUM",
  HIGH = "HIGH",
  CRITICAL = "CRITICAL",
}

export enum RuleAction {
  FLAG = "FLAG",
  REVIEW = "REVIEW",
  BLOCK = "BLOCK",
}

export enum AlertStatus {
  NEW = "NEW",
  ASSIGNED = "ASSIGNED",
  UNDER_REVIEW = "UNDER_REVIEW",
  CLOSED = "CLOSED",
  ESCALATED = "ESCALATED",
}

/** Recorded on Alert.closeCategory when status transitions to CLOSED (Section 9). */
export enum AlertCloseCategory {
  FALSE_POSITIVE = "FALSE_POSITIVE",
  RESOLVED = "RESOLVED",
}

/** One row per (rule, transaction) evaluation — audit trail, RuleEvaluation entity. */
export enum RuleEvaluationResultStatus {
  FIRED = "FIRED",
  NOT_FIRED = "NOT_FIRED",
  ERROR = "ERROR",
}

export enum RuleReplayStatus {
  QUEUED = "QUEUED",
  RUNNING = "RUNNING",
  COMPLETED = "COMPLETED",
  FAILED = "FAILED",
}
