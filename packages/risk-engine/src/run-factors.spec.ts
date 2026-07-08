import { RiskFactorType } from "@regops/shared";
import { runFactors } from "./run-factors";
import { RiskFactor, RiskFactorContext, RiskFactorResult } from "./types";
import { buildContext } from "./test-utils";

function stubFactor(type: RiskFactorType, rawValue: number): RiskFactor {
  return {
    type,
    async calculate(ctx: RiskFactorContext): Promise<RiskFactorResult> {
      return { factorType: type, rawValue, weight: ctx.config.weight, contributedScore: rawValue, detail: {} };
    },
  };
}

function throwingFactor(type: RiskFactorType, message: string): RiskFactor {
  return {
    type,
    async calculate(): Promise<RiskFactorResult> {
      throw new Error(message);
    },
  };
}

describe("runFactors", () => {
  it("runs every factor in order and collects their results", async () => {
    const factors = [stubFactor(RiskFactorType.CUSTOMER_TYPE, 10), stubFactor(RiskFactorType.COUNTRY, 20)];
    const results = await runFactors(factors, (factor) => buildContext(factor.type, {}));
    expect(results.map((r) => r.rawValue)).toEqual([10, 20]);
  });

  it("skips a factor when buildContext returns null (no tenant config row for that type)", async () => {
    const factors = [stubFactor(RiskFactorType.CUSTOMER_TYPE, 10), stubFactor(RiskFactorType.COUNTRY, 20)];
    const results = await runFactors(factors, (factor) =>
      factor.type === RiskFactorType.COUNTRY ? null : buildContext(factor.type, {}),
    );
    expect(results).toHaveLength(1);
    expect(results[0].rawValue).toBe(10);
  });

  it("propagates a thrown error instead of silently skipping the failing factor", async () => {
    const factors = [
      stubFactor(RiskFactorType.CUSTOMER_TYPE, 10),
      throwingFactor(RiskFactorType.COUNTRY, "country factor exploded"),
      stubFactor(RiskFactorType.KYC_TIER, 30),
    ];

    await expect(runFactors(factors, (factor) => buildContext(factor.type, {}))).rejects.toThrow(
      "country factor exploded",
    );
  });
});
