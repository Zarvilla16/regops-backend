import { ScreeningResultType } from "@regops/shared";

/**
 * Section 4.3's three score bands. Stored per-tenant under
 * Tenant.config["screening.thresholds"] (a DB/service-layer concern — this
 * package has no DB access), with these as the fallback when a tenant has no
 * override. Reused identically for banding a single provider match's score
 * and, if present, an internal blacklist hit's always-100 score.
 */
export interface ScreeningThresholds {
  /** Score at/above which a match is at least POTENTIAL_MATCH (else CLEAN). */
  potentialMatchMin: number;
  /** Score at/above which a match is CONFIRMED_MATCH. */
  confirmedMatchMin: number;
}

export const DEFAULT_SCREENING_THRESHOLDS: ScreeningThresholds = {
  potentialMatchMin: 60,
  confirmedMatchMin: 85,
};

export function bandScore(
  score: number,
  thresholds: ScreeningThresholds = DEFAULT_SCREENING_THRESHOLDS,
): ScreeningResultType {
  if (score >= thresholds.confirmedMatchMin) return ScreeningResultType.CONFIRMED_MATCH;
  if (score >= thresholds.potentialMatchMin) return ScreeningResultType.POTENTIAL_MATCH;
  return ScreeningResultType.CLEAN;
}

/** The overall check-level status is the band of its single highest match
 * score — a check with no matches at all is CLEAN by construction (score 0
 * bands to CLEAN under any sane threshold). */
export function bandHighestScore(
  highestMatchScore: number,
  thresholds: ScreeningThresholds = DEFAULT_SCREENING_THRESHOLDS,
): ScreeningResultType {
  return bandScore(highestMatchScore, thresholds);
}

export function parseTenantThresholds(tenantConfig: Record<string, unknown> | null | undefined): ScreeningThresholds {
  const raw = tenantConfig?.["screening.thresholds"];
  if (!raw || typeof raw !== "object") return DEFAULT_SCREENING_THRESHOLDS;

  const candidate = raw as Partial<ScreeningThresholds>;
  const potentialMatchMin =
    typeof candidate.potentialMatchMin === "number" ? candidate.potentialMatchMin : DEFAULT_SCREENING_THRESHOLDS.potentialMatchMin;
  const confirmedMatchMin =
    typeof candidate.confirmedMatchMin === "number" ? candidate.confirmedMatchMin : DEFAULT_SCREENING_THRESHOLDS.confirmedMatchMin;

  return { potentialMatchMin, confirmedMatchMin };
}
