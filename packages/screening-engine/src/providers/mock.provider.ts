import { ScreeningCheckType, ScreeningProviderName, ScreeningResultType } from "@regops/shared";
import { ProviderTransientError, ScreeningInput, ScreeningProvider, ScreeningResult } from "../types";

/**
 * Deterministic, driven entirely by `input.fullName` — see Section 7.3's
 * table. Used in dev, tests, and demos; CI never calls Smile ID or Prembly
 * (Section 7.3, last line). Order matters below: 'POSSIBLY_SANCTIONED'
 * contains 'SANCTIONED' as a substring, so it must be checked first or every
 * POSSIBLY_SANCTIONED input would incorrectly match the plain SANCTIONED
 * branch instead.
 */
export class MockProvider implements ScreeningProvider {
  readonly name = ScreeningProviderName.MOCK;
  readonly supportedChecks = [ScreeningCheckType.SANCTIONS, ScreeningCheckType.PEP, ScreeningCheckType.ADVERSE_MEDIA];

  async screen(_checkType: ScreeningCheckType, input: ScreeningInput, _config: Record<string, unknown>): Promise<ScreeningResult> {
    const start = Date.now();
    const name = input.fullName.toUpperCase();

    if (name.includes("TIMEOUT_TEST")) {
      throw new ProviderTransientError("MockProvider: simulated timeout for TIMEOUT_TEST");
    }
    if (name.includes("CRASH_TEST")) {
      throw new Error("MockProvider: simulated unhandled crash for CRASH_TEST");
    }

    if (name.includes("POSSIBLY_SANCTIONED")) {
      return this.buildResult(ScreeningResultType.POTENTIAL_MATCH, 72, [
        { listSource: "UN_CONSOLIDATED", matchName: input.fullName, matchScore: 72, matchData: { mock: true } },
      ], start);
    }
    if (name.includes("SANCTIONED")) {
      return this.buildResult(ScreeningResultType.CONFIRMED_MATCH, 95, [
        { listSource: "OFAC_SDN", matchName: input.fullName, matchScore: 95, matchData: { mock: true } },
      ], start);
    }
    if (name.includes("PEP")) {
      return this.buildResult(ScreeningResultType.CONFIRMED_MATCH, 90, [
        { listSource: "DOMESTIC_PEP", matchName: input.fullName, matchScore: 90, matchData: { mock: true } },
      ], start);
    }

    return this.buildResult(ScreeningResultType.CLEAN, 0, [], start);
  }

  private buildResult(
    status: ScreeningResultType,
    highestMatchScore: number,
    matches: ScreeningResult["matches"],
    startedAtMs: number,
  ): ScreeningResult {
    return {
      status,
      highestMatchScore,
      matches,
      providerReference: `MOCK-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      rawResponse: { mock: true, matches },
      latencyMs: Date.now() - startedAtMs,
    };
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: "mock provider always healthy" };
  }
}
