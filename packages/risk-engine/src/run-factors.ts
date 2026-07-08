import { RiskFactor, RiskFactorContext, RiskFactorResult } from "./types";

/**
 * Runs every factor in order and collects results. `buildContext` returns
 * null to skip a factor (e.g. no RiskFactorConfig row for that type yet —
 * shouldn't happen once tenant seeding has run, but skip rather than crash).
 *
 * Deliberately no try/catch around `factor.calculate()` — if a factor
 * throws, this function throws too, and the caller's transaction rolls
 * back. A wrong score is worse than a visible failure (see risk.service.ts
 * for backend Prompt 2 spec section 7.2's explicit requirement here).
 */
export async function runFactors(
  factors: RiskFactor[],
  buildContext: (factor: RiskFactor) => RiskFactorContext | null,
): Promise<RiskFactorResult[]> {
  const results: RiskFactorResult[] = [];
  for (const factor of factors) {
    const ctx = buildContext(factor);
    if (!ctx) continue;
    results.push(await factor.calculate(ctx));
  }
  return results;
}
