import { ScreeningResultType } from "@regops/shared";
import { bandScore, DEFAULT_SCREENING_THRESHOLDS, parseTenantThresholds } from "./thresholds";

describe("bandScore", () => {
  it("bands the default threshold boundaries per Section 4.3/10.2", () => {
    expect(bandScore(59)).toBe(ScreeningResultType.CLEAN);
    expect(bandScore(60)).toBe(ScreeningResultType.POTENTIAL_MATCH);
    expect(bandScore(84)).toBe(ScreeningResultType.POTENTIAL_MATCH);
    expect(bandScore(85)).toBe(ScreeningResultType.CONFIRMED_MATCH);
    expect(bandScore(100)).toBe(ScreeningResultType.CONFIRMED_MATCH);
    expect(bandScore(0)).toBe(ScreeningResultType.CLEAN);
  });

  it("honors custom thresholds", () => {
    const thresholds = { potentialMatchMin: 50, confirmedMatchMin: 90 };
    expect(bandScore(49, thresholds)).toBe(ScreeningResultType.CLEAN);
    expect(bandScore(50, thresholds)).toBe(ScreeningResultType.POTENTIAL_MATCH);
    expect(bandScore(90, thresholds)).toBe(ScreeningResultType.CONFIRMED_MATCH);
  });
});

describe("parseTenantThresholds", () => {
  it("falls back to defaults when tenant config has no screening.thresholds key", () => {
    expect(parseTenantThresholds({})).toEqual(DEFAULT_SCREENING_THRESHOLDS);
    expect(parseTenantThresholds(null)).toEqual(DEFAULT_SCREENING_THRESHOLDS);
    expect(parseTenantThresholds(undefined)).toEqual(DEFAULT_SCREENING_THRESHOLDS);
  });

  it("reads a tenant override", () => {
    const config = { "screening.thresholds": { potentialMatchMin: 55, confirmedMatchMin: 92 } };
    expect(parseTenantThresholds(config)).toEqual({ potentialMatchMin: 55, confirmedMatchMin: 92 });
  });

  it("falls back per-field when the override is partial", () => {
    const config = { "screening.thresholds": { potentialMatchMin: 55 } };
    expect(parseTenantThresholds(config)).toEqual({
      potentialMatchMin: 55,
      confirmedMatchMin: DEFAULT_SCREENING_THRESHOLDS.confirmedMatchMin,
    });
  });
});
