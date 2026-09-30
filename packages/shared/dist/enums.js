"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReportStatus = exports.ReportType = exports.CaseApprovalOutcome = exports.CasePriority = exports.CaseStatus = exports.RuleReplayStatus = exports.RuleEvaluationResultStatus = exports.AlertCloseCategory = exports.AlertStatus = exports.RuleAction = exports.AlertSeverity = exports.RuleScenarioType = exports.UnknownCustomerMode = exports.IngestionBatchStatus = exports.AccountStatus = exports.AccountType = exports.TransactionSource = exports.TransactionChannel = exports.TransactionType = exports.PepStatus = exports.PepCategory = exports.MatchDecision = exports.MatchReviewStatus = exports.ScreeningTrigger = exports.ScreeningResultType = exports.ScreeningCheckStatus = exports.ScreeningCheckType = exports.ScreeningProviderName = exports.RiskFactorType = exports.ScoreTrigger = exports.RiskLevel = exports.CustomerStatus = exports.CustomerType = exports.MFA_MANDATORY_ROLES = exports.UserStatus = exports.UserRole = exports.TenantStatus = exports.TenantType = void 0;
var TenantType;
(function (TenantType) {
    TenantType["MFB"] = "MFB";
    TenantType["FINTECH"] = "FINTECH";
    TenantType["PSP"] = "PSP";
    TenantType["MMO"] = "MMO";
})(TenantType || (exports.TenantType = TenantType = {}));
var TenantStatus;
(function (TenantStatus) {
    TenantStatus["ACTIVE"] = "ACTIVE";
    TenantStatus["SUSPENDED"] = "SUSPENDED";
    TenantStatus["PENDING"] = "PENDING";
})(TenantStatus || (exports.TenantStatus = TenantStatus = {}));
var UserRole;
(function (UserRole) {
    UserRole["SUPER_ADMIN"] = "SUPER_ADMIN";
    UserRole["TENANT_ADMIN"] = "TENANT_ADMIN";
    UserRole["COMPLIANCE_OFFICER"] = "COMPLIANCE_OFFICER";
    UserRole["INVESTIGATOR"] = "INVESTIGATOR";
    UserRole["VIEWER"] = "VIEWER";
})(UserRole || (exports.UserRole = UserRole = {}));
var UserStatus;
(function (UserStatus) {
    UserStatus["ACTIVE"] = "ACTIVE";
    UserStatus["INVITED"] = "INVITED";
    UserStatus["SUSPENDED"] = "SUSPENDED";
})(UserStatus || (exports.UserStatus = UserStatus = {}));
/** Roles for which MFA enrollment is mandatory before full access is granted. */
exports.MFA_MANDATORY_ROLES = [
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.COMPLIANCE_OFFICER,
];
var CustomerType;
(function (CustomerType) {
    CustomerType["INDIVIDUAL"] = "INDIVIDUAL";
    CustomerType["SME"] = "SME";
    CustomerType["CORPORATE"] = "CORPORATE";
    CustomerType["NGO"] = "NGO";
    CustomerType["GOVERNMENT"] = "GOVERNMENT";
    CustomerType["PEP"] = "PEP";
})(CustomerType || (exports.CustomerType = CustomerType = {}));
var CustomerStatus;
(function (CustomerStatus) {
    CustomerStatus["ACTIVE"] = "ACTIVE";
    CustomerStatus["DORMANT"] = "DORMANT";
    CustomerStatus["BLOCKED"] = "BLOCKED";
    CustomerStatus["CLOSED"] = "CLOSED";
    /** Set only by CustomersService.create() when the new customer is a PEP
     * (Backend Prompt 3.5, Section 2) — the Customer row exists (so
     * screening/audit can reference it) but isn't treated as fully onboarded
     * until POST /customers/:id/approve-pep transitions it to ACTIVE. Not
     * directly settable via PATCH /customers/:id — see CustomersService.update. */
    CustomerStatus["PENDING_EDD_APPROVAL"] = "PENDING_EDD_APPROVAL";
    /** Set only by the transaction ingestion pipeline's auto_create_stub mode
     * (Backend Prompt 4, Section 5.6) — a Customer row created solely because
     * an incoming transaction referenced an unknown cbs_customer_id, so
     * something can reference it, but real KYC onboarding hasn't happened yet. */
    CustomerStatus["PENDING_KYC"] = "PENDING_KYC";
})(CustomerStatus || (exports.CustomerStatus = CustomerStatus = {}));
var RiskLevel;
(function (RiskLevel) {
    RiskLevel["LOW"] = "LOW";
    RiskLevel["MEDIUM"] = "MEDIUM";
    RiskLevel["HIGH"] = "HIGH";
    RiskLevel["CRITICAL"] = "CRITICAL";
})(RiskLevel || (exports.RiskLevel = RiskLevel = {}));
/** What caused a risk score to be (re)calculated — recorded on every RiskScoreHistory row. */
var ScoreTrigger;
(function (ScoreTrigger) {
    ScoreTrigger["INITIAL"] = "INITIAL";
    ScoreTrigger["SCHEDULED"] = "SCHEDULED";
    ScoreTrigger["MANUAL"] = "MANUAL";
    ScoreTrigger["SCREENING_MATCH"] = "SCREENING_MATCH";
    ScoreTrigger["CUSTOMER_UPDATED"] = "CUSTOMER_UPDATED";
    /** transaction.ingested, debounced 60s per customer (Backend Prompt 4, Section 9.4). */
    ScoreTrigger["TRANSACTION_ACTIVITY"] = "TRANSACTION_ACTIVITY";
})(ScoreTrigger || (exports.ScoreTrigger = ScoreTrigger = {}));
/** Which discrete RiskFactor implementation a RiskFactorConfig row tunes. */
var RiskFactorType;
(function (RiskFactorType) {
    RiskFactorType["CUSTOMER_TYPE"] = "CUSTOMER_TYPE";
    RiskFactorType["OCCUPATION"] = "OCCUPATION";
    RiskFactorType["COUNTRY"] = "COUNTRY";
    RiskFactorType["PRODUCT_MIX"] = "PRODUCT_MIX";
    RiskFactorType["TRANSACTION_VELOCITY"] = "TRANSACTION_VELOCITY";
    RiskFactorType["KYC_TIER"] = "KYC_TIER";
})(RiskFactorType || (exports.RiskFactorType = RiskFactorType = {}));
// --- Screening (Backend Prompt 3) ------------------------------------------
var ScreeningProviderName;
(function (ScreeningProviderName) {
    ScreeningProviderName["SMILE_ID"] = "SMILE_ID";
    ScreeningProviderName["PREMBLY"] = "PREMBLY";
    ScreeningProviderName["MOCK"] = "MOCK";
})(ScreeningProviderName || (exports.ScreeningProviderName = ScreeningProviderName = {}));
var ScreeningCheckType;
(function (ScreeningCheckType) {
    ScreeningCheckType["SANCTIONS"] = "SANCTIONS";
    ScreeningCheckType["PEP"] = "PEP";
    ScreeningCheckType["ADVERSE_MEDIA"] = "ADVERSE_MEDIA";
})(ScreeningCheckType || (exports.ScreeningCheckType = ScreeningCheckType = {}));
var ScreeningCheckStatus;
(function (ScreeningCheckStatus) {
    ScreeningCheckStatus["PENDING"] = "PENDING";
    ScreeningCheckStatus["COMPLETED"] = "COMPLETED";
    ScreeningCheckStatus["FAILED"] = "FAILED";
    ScreeningCheckStatus["TIMEOUT"] = "TIMEOUT";
})(ScreeningCheckStatus || (exports.ScreeningCheckStatus = ScreeningCheckStatus = {}));
/** Named ScreeningResultType (not just "ScreeningResult") since that name is
 * reserved for the richer provider-call return shape in screening-engine. */
var ScreeningResultType;
(function (ScreeningResultType) {
    ScreeningResultType["CLEAN"] = "CLEAN";
    ScreeningResultType["POTENTIAL_MATCH"] = "POTENTIAL_MATCH";
    ScreeningResultType["CONFIRMED_MATCH"] = "CONFIRMED_MATCH";
    ScreeningResultType["ERROR"] = "ERROR";
})(ScreeningResultType || (exports.ScreeningResultType = ScreeningResultType = {}));
var ScreeningTrigger;
(function (ScreeningTrigger) {
    ScreeningTrigger["ONBOARDING"] = "ONBOARDING";
    ScreeningTrigger["SCHEDULED"] = "SCHEDULED";
    ScreeningTrigger["MANUAL"] = "MANUAL";
    ScreeningTrigger["UPDATE"] = "UPDATE";
    /** Counterparty screening for the HIGH_RISK_COUNTERPARTY rule (Backend
     * Prompt 5, Section 6.4) — added to screening_trigger_enum via
     * RulesAndAlerts1700000050000's ALTER TYPE ADD VALUE. */
    ScreeningTrigger["TRANSACTION_MONITORING"] = "TRANSACTION_MONITORING";
})(ScreeningTrigger || (exports.ScreeningTrigger = ScreeningTrigger = {}));
var MatchReviewStatus;
(function (MatchReviewStatus) {
    MatchReviewStatus["PENDING_REVIEW"] = "PENDING_REVIEW";
    MatchReviewStatus["REVIEWED"] = "REVIEWED";
})(MatchReviewStatus || (exports.MatchReviewStatus = MatchReviewStatus = {}));
var MatchDecision;
(function (MatchDecision) {
    MatchDecision["TRUE_POSITIVE"] = "TRUE_POSITIVE";
    MatchDecision["FALSE_POSITIVE"] = "FALSE_POSITIVE";
})(MatchDecision || (exports.MatchDecision = MatchDecision = {}));
// --- Customer module enhancements (Backend Prompt 3.5) ---------------------
var PepCategory;
(function (PepCategory) {
    PepCategory["DOMESTIC"] = "DOMESTIC";
    PepCategory["FOREIGN"] = "FOREIGN";
    PepCategory["INTERNATIONAL_ORG"] = "INTERNATIONAL_ORG";
})(PepCategory || (exports.PepCategory = PepCategory = {}));
/** null pepEndDate means still current — pepStatus is a separate, explicit
 * field rather than derived from that, since a FORMER PEP's monitoring
 * obligations (Section 1) don't reduce to "has an end date". */
var PepStatus;
(function (PepStatus) {
    PepStatus["CURRENT"] = "CURRENT";
    PepStatus["FORMER"] = "FORMER";
})(PepStatus || (exports.PepStatus = PepStatus = {}));
// --- Transactions (Backend Prompt 4) ----------------------------------------
var TransactionType;
(function (TransactionType) {
    TransactionType["CREDIT"] = "CREDIT";
    TransactionType["DEBIT"] = "DEBIT";
})(TransactionType || (exports.TransactionType = TransactionType = {}));
var TransactionChannel;
(function (TransactionChannel) {
    TransactionChannel["BRANCH"] = "BRANCH";
    TransactionChannel["MOBILE"] = "MOBILE";
    TransactionChannel["USSD"] = "USSD";
    TransactionChannel["POS"] = "POS";
    TransactionChannel["AGENT"] = "AGENT";
    TransactionChannel["TRANSFER"] = "TRANSFER";
    TransactionChannel["CASH"] = "CASH";
    TransactionChannel["CARD"] = "CARD";
    TransactionChannel["ATM"] = "ATM";
    TransactionChannel["API"] = "API";
    TransactionChannel["OTHER"] = "OTHER";
})(TransactionChannel || (exports.TransactionChannel = TransactionChannel = {}));
/** Also used as IngestionBatch.source — every batch's rows share one origin. */
var TransactionSource;
(function (TransactionSource) {
    TransactionSource["SFTP"] = "SFTP";
    TransactionSource["WEBHOOK"] = "WEBHOOK";
    TransactionSource["MANUAL"] = "MANUAL";
    TransactionSource["BACKFILL"] = "BACKFILL";
})(TransactionSource || (exports.TransactionSource = TransactionSource = {}));
var AccountType;
(function (AccountType) {
    AccountType["SAVINGS"] = "SAVINGS";
    AccountType["CURRENT"] = "CURRENT";
    AccountType["LOAN"] = "LOAN";
    AccountType["FIXED_DEPOSIT"] = "FIXED_DEPOSIT";
    AccountType["WALLET"] = "WALLET";
    AccountType["OTHER"] = "OTHER";
})(AccountType || (exports.AccountType = AccountType = {}));
var AccountStatus;
(function (AccountStatus) {
    AccountStatus["ACTIVE"] = "ACTIVE";
    AccountStatus["DORMANT"] = "DORMANT";
    AccountStatus["BLOCKED"] = "BLOCKED";
    AccountStatus["CLOSED"] = "CLOSED";
})(AccountStatus || (exports.AccountStatus = AccountStatus = {}));
var IngestionBatchStatus;
(function (IngestionBatchStatus) {
    IngestionBatchStatus["QUEUED"] = "QUEUED";
    IngestionBatchStatus["PROCESSING"] = "PROCESSING";
    IngestionBatchStatus["COMPLETED"] = "COMPLETED";
    IngestionBatchStatus["COMPLETED_WITH_ERRORS"] = "COMPLETED_WITH_ERRORS";
    IngestionBatchStatus["FAILED"] = "FAILED";
})(IngestionBatchStatus || (exports.IngestionBatchStatus = IngestionBatchStatus = {}));
/**
 * Governs how IngestionService resolves a row's customer_cbs_id (spec
 * Section 5.6). `buffer` (side-table + later linking) is explicitly v2 in
 * the spec and is not implemented — tenants must be in `reject` or
 * `auto_create_stub` mode.
 */
var UnknownCustomerMode;
(function (UnknownCustomerMode) {
    UnknownCustomerMode["REJECT"] = "REJECT";
    UnknownCustomerMode["AUTO_CREATE_STUB"] = "AUTO_CREATE_STUB";
})(UnknownCustomerMode || (exports.UnknownCustomerMode = UnknownCustomerMode = {}));
// --- Rules & Alerts (Backend Prompt 5) --------------------------------------
var RuleScenarioType;
(function (RuleScenarioType) {
    RuleScenarioType["LARGE_CASH"] = "LARGE_CASH";
    RuleScenarioType["STRUCTURING"] = "STRUCTURING";
    RuleScenarioType["RAPID_INFLOW_OUTFLOW"] = "RAPID_INFLOW_OUTFLOW";
    RuleScenarioType["HIGH_RISK_COUNTERPARTY"] = "HIGH_RISK_COUNTERPARTY";
    RuleScenarioType["VELOCITY_SPIKE"] = "VELOCITY_SPIKE";
})(RuleScenarioType || (exports.RuleScenarioType = RuleScenarioType = {}));
var AlertSeverity;
(function (AlertSeverity) {
    AlertSeverity["LOW"] = "LOW";
    AlertSeverity["MEDIUM"] = "MEDIUM";
    AlertSeverity["HIGH"] = "HIGH";
    AlertSeverity["CRITICAL"] = "CRITICAL";
})(AlertSeverity || (exports.AlertSeverity = AlertSeverity = {}));
var RuleAction;
(function (RuleAction) {
    RuleAction["FLAG"] = "FLAG";
    RuleAction["REVIEW"] = "REVIEW";
    RuleAction["BLOCK"] = "BLOCK";
})(RuleAction || (exports.RuleAction = RuleAction = {}));
var AlertStatus;
(function (AlertStatus) {
    AlertStatus["NEW"] = "NEW";
    AlertStatus["ASSIGNED"] = "ASSIGNED";
    AlertStatus["UNDER_REVIEW"] = "UNDER_REVIEW";
    AlertStatus["CLOSED"] = "CLOSED";
    AlertStatus["ESCALATED"] = "ESCALATED";
})(AlertStatus || (exports.AlertStatus = AlertStatus = {}));
/** Recorded on Alert.closeCategory when status transitions to CLOSED (Section 9). */
var AlertCloseCategory;
(function (AlertCloseCategory) {
    AlertCloseCategory["FALSE_POSITIVE"] = "FALSE_POSITIVE";
    AlertCloseCategory["RESOLVED"] = "RESOLVED";
})(AlertCloseCategory || (exports.AlertCloseCategory = AlertCloseCategory = {}));
/** One row per (rule, transaction) evaluation — audit trail, RuleEvaluation entity. */
var RuleEvaluationResultStatus;
(function (RuleEvaluationResultStatus) {
    RuleEvaluationResultStatus["FIRED"] = "FIRED";
    RuleEvaluationResultStatus["NOT_FIRED"] = "NOT_FIRED";
    RuleEvaluationResultStatus["ERROR"] = "ERROR";
})(RuleEvaluationResultStatus || (exports.RuleEvaluationResultStatus = RuleEvaluationResultStatus = {}));
var RuleReplayStatus;
(function (RuleReplayStatus) {
    RuleReplayStatus["QUEUED"] = "QUEUED";
    RuleReplayStatus["RUNNING"] = "RUNNING";
    RuleReplayStatus["COMPLETED"] = "COMPLETED";
    RuleReplayStatus["FAILED"] = "FAILED";
})(RuleReplayStatus || (exports.RuleReplayStatus = RuleReplayStatus = {}));
// --- Case Management (Backend Prompt 6) -------------------------------------
var CaseStatus;
(function (CaseStatus) {
    CaseStatus["OPEN"] = "OPEN";
    CaseStatus["UNDER_INVESTIGATION"] = "UNDER_INVESTIGATION";
    CaseStatus["PENDING_APPROVAL"] = "PENDING_APPROVAL";
    CaseStatus["SAR_FILED"] = "SAR_FILED";
    CaseStatus["CLOSED"] = "CLOSED";
})(CaseStatus || (exports.CaseStatus = CaseStatus = {}));
var CasePriority;
(function (CasePriority) {
    CasePriority["LOW"] = "LOW";
    CasePriority["MEDIUM"] = "MEDIUM";
    CasePriority["HIGH"] = "HIGH";
})(CasePriority || (exports.CasePriority = CasePriority = {}));
/** Recorded on CaseApprovalEvent.outcome — one row per approve/reject decision on a PENDING_APPROVAL case. */
var CaseApprovalOutcome;
(function (CaseApprovalOutcome) {
    CaseApprovalOutcome["APPROVED"] = "APPROVED";
    CaseApprovalOutcome["REJECTED"] = "REJECTED";
})(CaseApprovalOutcome || (exports.CaseApprovalOutcome = CaseApprovalOutcome = {}));
/** SAR (from an approved Case) or CTR (from a qualifying cash Transaction) — see ReportEntity. */
var ReportType;
(function (ReportType) {
    ReportType["SAR"] = "SAR";
    ReportType["CTR"] = "CTR";
})(ReportType || (exports.ReportType = ReportType = {}));
/** DRAFT -> PENDING_CONFIRMATION -> SUBMITTED (reject returns PENDING_CONFIRMATION to DRAFT). SUBMITTED is terminal. */
var ReportStatus;
(function (ReportStatus) {
    ReportStatus["DRAFT"] = "DRAFT";
    ReportStatus["PENDING_CONFIRMATION"] = "PENDING_CONFIRMATION";
    ReportStatus["SUBMITTED"] = "SUBMITTED";
})(ReportStatus || (exports.ReportStatus = ReportStatus = {}));
//# sourceMappingURL=enums.js.map