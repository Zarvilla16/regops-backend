import { RiskFactorType, RiskLevel } from "@regops/shared";
import { aggregateRiskScore, bandLevel } from "./aggregate";
import { RiskFactorResult } from "./types";

function result(factorType: RiskFactorType, contributedScore: number): RiskFactorResult {
  return { factorType, rawValue: contributedScore, weight: 1, contributedScore, detail: {} };
}

describe("aggregateRiskScore", () => {
  it("score is the sum of every factor's contributedScore", () => {
    const results = [
      result(RiskFactorType.CUSTOMER_TYPE, 10),
      result(RiskFactorType.OCCUPATION, 5),
      result(RiskFactorType.COUNTRY, 0),
    ];
    const { score } = aggregateRiskScore(results, { isPep: false, isSanctioned: false });
    expect(score).toBe(15);
  });

  it("score is capped at 100 even when the sum of factors exceeds it", () => {
    const results = [result(RiskFactorType.CUSTOMER_TYPE, 80), result(RiskFactorType.COUNTRY, 100)];
    const { score } = aggregateRiskScore(results, { isPep: false, isSanctioned: false });
    expect(score).toBe(100);
  });

  describe("banding boundaries", () => {
    it.each([
      [0, RiskLevel.LOW],
      [30, RiskLevel.LOW],
      [31, RiskLevel.MEDIUM],
      [60, RiskLevel.MEDIUM],
      [61, RiskLevel.HIGH],
      [85, RiskLevel.HIGH],
      [86, RiskLevel.CRITICAL],
      [100, RiskLevel.CRITICAL],
    ])("score %i bands to %s", (score, expectedLevel) => {
      expect(bandLevel(score)).toBe(expectedLevel);
    });

    it.each([
      [30, RiskLevel.LOW],
      [31, RiskLevel.MEDIUM],
      [60, RiskLevel.MEDIUM],
      [61, RiskLevel.HIGH],
      [85, RiskLevel.HIGH],
      [86, RiskLevel.CRITICAL],
    ])("aggregateRiskScore bands a total of %i to %s", (total, expectedLevel) => {
      const { level } = aggregateRiskScore([result(RiskFactorType.CUSTOMER_TYPE, total)], {
        isPep: false,
        isSanctioned: false,
      });
      expect(level).toBe(expectedLevel);
    });
  });

  it("is_pep override forces CRITICAL even when the computed score is 0", () => {
    const { score, level, factors } = aggregateRiskScore([result(RiskFactorType.CUSTOMER_TYPE, 0)], {
      isPep: true,
      isSanctioned: false,
    });
    expect(score).toBe(0);
    expect(level).toBe(RiskLevel.CRITICAL);
    expect(factors.override).toBe("PEP_FLAG");
  });

  it("is_sanctioned override forces CRITICAL even when the computed score is 0", () => {
    const { level, factors } = aggregateRiskScore([result(RiskFactorType.CUSTOMER_TYPE, 0)], {
      isPep: false,
      isSanctioned: true,
    });
    expect(level).toBe(RiskLevel.CRITICAL);
    expect(factors.override).toBe("PEP_FLAG");
  });

  it("without a PEP/sanctioned override, no override key is recorded in factors", () => {
    const { factors } = aggregateRiskScore([result(RiskFactorType.CUSTOMER_TYPE, 20)], {
      isPep: false,
      isSanctioned: false,
    });
    expect(factors.override).toBeUndefined();
  });

  it("factors breakdown includes every factor's rawValue/weight/contributedScore/detail", () => {
    const results = [
      { factorType: RiskFactorType.CUSTOMER_TYPE, rawValue: 20, weight: 1, contributedScore: 20, detail: { a: 1 } },
    ];
    const { factors } = aggregateRiskScore(results, { isPep: false, isSanctioned: false });
    expect(factors[RiskFactorType.CUSTOMER_TYPE]).toEqual({
      rawValue: 20,
      weight: 1,
      contributedScore: 20,
      detail: { a: 1 },
    });
  });
});
