import { RiskFactorType } from "@regops/shared";
import { CountryFactor } from "./country.factor";
import { buildContext } from "../test-utils";

const DEFAULT_CONFIG = {
  fatfBlacklist: ["IR", "KP", "MM"],
  fatfGreylist: ["AF", "SY", "YE", "LY"],
  highRisk: ["VE", "IQ", "LB", "SO"],
  default: 0,
};

describe("CountryFactor", () => {
  const factor = new CountryFactor();

  it("happy path: FATF blacklist country scores 100", async () => {
    const ctx = buildContext(RiskFactorType.COUNTRY, DEFAULT_CONFIG, { customer: { country: "IR" } });
    const result = await factor.calculate(ctx);
    expect(result.rawValue).toBe(100);
  });

  it("happy path: FATF greylist country scores 60", async () => {
    const ctx = buildContext(RiskFactorType.COUNTRY, DEFAULT_CONFIG, { customer: { country: "SY" } });
    const result = await factor.calculate(ctx);
    expect(result.rawValue).toBe(60);
  });

  it("happy path: high-risk (non-FATF) country scores 40", async () => {
    const ctx = buildContext(RiskFactorType.COUNTRY, DEFAULT_CONFIG, { customer: { country: "VE" } });
    const result = await factor.calculate(ctx);
    expect(result.rawValue).toBe(40);
  });

  it("happy path: an unlisted country scores the configured default", async () => {
    const ctx = buildContext(RiskFactorType.COUNTRY, DEFAULT_CONFIG, { customer: { country: "NG" } });
    const result = await factor.calculate(ctx);
    expect(result.rawValue).toBe(0);
  });

  it("edge case: unknown/unrecognized country code falls through to default rather than throwing", async () => {
    const ctx = buildContext(RiskFactorType.COUNTRY, DEFAULT_CONFIG, { customer: { country: "ZZ" } });
    const result = await factor.calculate(ctx);
    expect(result.rawValue).toBe(0);
  });

  it("edge case: a config with no list keys at all defaults to 0 rather than throwing", async () => {
    const ctx = buildContext(RiskFactorType.COUNTRY, {}, { customer: { country: "IR" } });
    const result = await factor.calculate(ctx);
    expect(result.rawValue).toBe(0);
  });

  it("takes the higher of country vs. nationality scores", async () => {
    const ctx = buildContext(RiskFactorType.COUNTRY, DEFAULT_CONFIG, {
      customer: { country: "NG", nationality: "IR" },
    });
    const result = await factor.calculate(ctx);
    expect(result.rawValue).toBe(100);
    expect(result.detail.countryScore).toBe(0);
    expect(result.detail.nationalityScore).toBe(100);
  });

  it("edge case: null nationality doesn't affect the result", async () => {
    const ctx = buildContext(RiskFactorType.COUNTRY, DEFAULT_CONFIG, {
      customer: { country: "VE", nationality: null },
    });
    const result = await factor.calculate(ctx);
    expect(result.rawValue).toBe(40);
    expect(result.detail.nationalityScore).toBeNull();
  });

  it("config variation: weight proportionally scales contributedScore", async () => {
    const ctx = buildContext(RiskFactorType.COUNTRY, DEFAULT_CONFIG, {
      customer: { country: "VE" },
      weight: 0.25,
    });
    const result = await factor.calculate(ctx);
    expect(result.rawValue).toBe(40);
    expect(result.contributedScore).toBe(10);
  });

  it("determinism: identical input produces identical output across repeated calls", async () => {
    const ctx = buildContext(RiskFactorType.COUNTRY, DEFAULT_CONFIG, {
      customer: { country: "IQ", nationality: "AF" },
    });
    const first = await factor.calculate(ctx);
    const second = await factor.calculate(ctx);
    expect(second).toEqual(first);
  });
});
