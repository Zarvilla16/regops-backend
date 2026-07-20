/**
 * Section 9.2's guardrail: "reduction of thresholds (which loosens
 * monitoring) requires X-Confirm-Loosening: true. Without it, 422." Per-key
 * table of whether INCREASING that numeric config field loosens (true) or
 * tightens (false) detection sensitivity — the inverse direction (decrease)
 * has the opposite effect. Keys not listed here are not sensitivity dials
 * (booleans, enums, statistical tuning parameters like historyDays) and
 * never trigger the guardrail.
 */
export const LOOSENS_ON_INCREASE: Record<string, boolean> = {
  // LARGE_CASH / STRUCTURING
  thresholdIndividual: true,
  thresholdCorporate: true,
  largeCashThresholdIndividual: true,
  largeCashThresholdCorporate: true,
  minCount: true,
  cumulativeThreshold: true,
  // A longer window catches MORE of a pattern, not less — increasing it
  // tightens detection; shrinking the window is what loosens it.
  windowHours: false,
  // RAPID_INFLOW_OUTFLOW
  windowMinutes: false,
  outflowRatio: true,
  minInboundAmount: true,
  // HIGH_RISK_COUNTERPARTY
  skipBelowAmount: true,
  externalScreeningCacheHours: true,
  // VELOCITY_SPIKE
  minSpikeRatio: true,
  minAbsoluteAmount: true,
  excludeNewCustomersDays: true,
};

function isLooseningFieldChange(key: string, before: unknown, after: unknown): boolean {
  const direction = LOOSENS_ON_INCREASE[key];
  if (direction === undefined) return false;
  if (typeof before !== "number" || typeof after !== "number" || after === before) return false;
  const increased = after > before;
  return direction ? increased : !increased;
}

export interface LooseningCheckResult {
  isLoosening: boolean;
  changedKeys: string[];
}

/** Compares only the keys present in `incomingConfig` against the rule's
 * current config — untouched keys never factor into the decision. */
export function detectLoosening(
  currentConfig: Record<string, unknown>,
  incomingConfig: Record<string, unknown>,
): LooseningCheckResult {
  const changedKeys: string[] = [];
  for (const key of Object.keys(incomingConfig)) {
    if (isLooseningFieldChange(key, currentConfig[key], incomingConfig[key])) {
      changedKeys.push(key);
    }
  }
  return { isLoosening: changedKeys.length > 0, changedKeys };
}
