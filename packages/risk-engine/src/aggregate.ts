import { RiskLevel } from "@regops/shared";
import { RiskFactorResult } from "./types";

export interface AggregateResult {
  score: number;
  level: RiskLevel;
  /** Persisted verbatim into RiskScoreHistory.factors — a full breakdown of how this score was reached. */
  factors: Record<string, unknown>;
}

export function bandLevel(score: number): RiskLevel {
  if (score <= 30) return RiskLevel.LOW;
  if (score <= 60) return RiskLevel.MEDIUM;
  if (score <= 85) return RiskLevel.HIGH;
  return RiskLevel.CRITICAL;
}

/**
 * Sums each factor's already-capped contributedScore, caps the total at
 * 100, then bands it into a RiskLevel. If the customer is a PEP or
 * sanctioned, the level is forced to CRITICAL regardless of the computed
 * score — recorded as `{ override: "PEP_FLAG" }` in factors (the spec's
 * literal marker for both cases, not just the PEP one).
 */
export function aggregateRiskScore(
  results: RiskFactorResult[],
  customer: { isPep: boolean; isSanctioned: boolean },
): AggregateResult {
  const totalRaw = results.reduce((sum, r) => sum + r.contributedScore, 0);
  const score = Math.min(Math.round(totalRaw), 100);
  let level = bandLevel(score);

  const factors: Record<string, unknown> = {};
  for (const result of results) {
    factors[result.factorType] = {
      rawValue: result.rawValue,
      weight: result.weight,
      contributedScore: result.contributedScore,
      detail: result.detail,
    };
  }

  if (customer.isPep || customer.isSanctioned) {
    level = RiskLevel.CRITICAL;
    factors.override = "PEP_FLAG";
  }

  return { score, level, factors };
}
