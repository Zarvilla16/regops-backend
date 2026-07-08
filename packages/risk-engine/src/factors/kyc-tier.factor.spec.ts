import { RiskFactorType } from "@regops/shared";
import { KycTierFactor } from "./kyc-tier.factor";
import { buildContext } from "../test-utils";

const DEFAULT_CONFIG = { scores: { "1": 30, "2": 15, "3": 0 } };

describe("KycTierFactor", () => {
  const factor = new KycTierFactor();

  it("happy path: lower KYC tier scores higher risk (inverse relationship)", async () => {
    const tier1 = await factor.calculate(buildContext(RiskFactorType.KYC_TIER, DEFAULT_CONFIG, { customer: { kycTier: 1 } }));
    const tier2 = await factor.calculate(buildContext(RiskFactorType.KYC_TIER, DEFAULT_CONFIG, { customer: { kycTier: 2 } }));
    const tier3 = await factor.calculate(buildContext(RiskFactorType.KYC_TIER, DEFAULT_CONFIG, { customer: { kycTier: 3 } }));

    expect(tier1.rawValue).toBe(30);
    expect(tier2.rawValue).toBe(15);
    expect(tier3.rawValue).toBe(0);
    expect(tier1.rawValue).toBeGreaterThan(tier2.rawValue);
    expect(tier2.rawValue).toBeGreaterThan(tier3.rawValue);
  });

  it("edge case: a tier missing from config.scores defaults to 0", async () => {
    const ctx = buildContext(RiskFactorType.KYC_TIER, { scores: { "1": 30 } }, { customer: { kycTier: 2 } });
    const result = await factor.calculate(ctx);
    expect(result.rawValue).toBe(0);
  });

  it("edge case: a config with no scores key at all defaults to 0 rather than throwing", async () => {
    const ctx = buildContext(RiskFactorType.KYC_TIER, {}, { customer: { kycTier: 1 } });
    const result = await factor.calculate(ctx);
    expect(result.rawValue).toBe(0);
  });

  it("config variation: weight proportionally scales contributedScore", async () => {
    const ctx = buildContext(RiskFactorType.KYC_TIER, DEFAULT_CONFIG, { customer: { kycTier: 1 }, weight: 2 });
    const result = await factor.calculate(ctx);
    expect(result.rawValue).toBe(30);
    expect(result.contributedScore).toBe(60);
  });

  it("determinism: identical input produces identical output across repeated calls", async () => {
    const ctx = buildContext(RiskFactorType.KYC_TIER, DEFAULT_CONFIG, { customer: { kycTier: 2 } });
    const first = await factor.calculate(ctx);
    const second = await factor.calculate(ctx);
    expect(second).toEqual(first);
  });
});
