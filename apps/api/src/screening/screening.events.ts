/** Event name constants — subscribers should reference these, not string literals (Section 8). */
export const SCREENING_EVENTS = {
  CHECK_COMPLETED: "screening.check.completed",
  MATCH_FOUND: "screening.match.found",
  SANCTIONS_CONFIRMED: "customer.sanctions_confirmed",
  PEP_CONFIRMED: "customer.pep_confirmed",
  SANCTIONS_FLAGGED: "customer.sanctions_flagged",
  PEP_FLAGGED: "customer.pep_flagged",
} as const;

export interface ScreeningCheckCompletedEvent {
  tenantId: string;
  checkId: string;
  customerId: string | null;
  checkType: string;
  result: string;
}

export interface ScreeningMatchFoundEvent {
  tenantId: string;
  matchId: string;
  checkId: string;
  customerId: string;
  matchScore: number;
}

/** Emitted when a compliance officer reviews a match as TRUE_POSITIVE
 * (Section 8) — distinct from *_flagged below, which fire for an
 * automated CONFIRMED_MATCH with no human review involved. */
export interface CustomerSanctionsConfirmedEvent {
  tenantId: string;
  customerId: string;
  matchId: string;
  reviewedBy: string;
}

export interface CustomerPepConfirmedEvent {
  tenantId: string;
  customerId: string;
  matchId: string;
  reviewedBy: string;
}

/** Emitted when a SCHEDULED re-screen finds a CONFIRMED_MATCH for sanctions
 * on an already-onboarded customer (Section 5.3) — never for the sync
 * onboarding block, which throws instead of creating the customer at all. */
export interface CustomerSanctionsFlaggedEvent {
  tenantId: string;
  customerId: string;
  checkId: string;
  matchId: string;
}

/** Emitted when an async (new-customer) or scheduled PEP check finds a
 * CONFIRMED_MATCH (Section 5.2/5.3). */
export interface CustomerPepFlaggedEvent {
  tenantId: string;
  customerId: string;
  checkId: string;
  matchId: string;
}
