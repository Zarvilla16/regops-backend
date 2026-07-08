import { RiskFactorType } from "@regops/shared";
import { OccupationFactor } from "./occupation.factor";
import { buildContext } from "../test-utils";

const DEFAULT_CONFIG = {
  highRiskKeywords: ["cash-intensive", "politically connected", "gambling", "crypto", "jewelry", "dealer"],
  highRiskScore: 60,
  mediumRiskKeywords: ["trader", "importer", "exporter", "contractor"],
  mediumRiskScore: 30,
  defaultScore: 10,
};

describe("OccupationFactor", () => {
  const factor = new OccupationFactor();

  it("happy path: a high-risk keyword match scores highRiskScore", async () => {
    const ctx = buildContext(RiskFactorType.OCCUPATION, DEFAULT_CONFIG, {
      customer: { occupation: "Crypto asset manager" },
    });
    const result = await factor.calculate(ctx);
    expect(result.rawValue).toBe(60);
    expect(result.detail.matched).toBe("high");
  });

  it("happy path: a medium-risk keyword match scores mediumRiskScore", async () => {
    const ctx = buildContext(RiskFactorType.OCCUPATION, DEFAULT_CONFIG, {
      customer: { occupation: "Import/export trader" },
    });
    const result = await factor.calculate(ctx);
    expect(result.rawValue).toBe(30);
    expect(result.detail.matched).toBe("medium");
  });

  it("happy path: no keyword match scores defaultScore", async () => {
    const ctx = buildContext(RiskFactorType.OCCUPATION, DEFAULT_CONFIG, {
      customer: { occupation: "Software Engineer" },
    });
    const result = await factor.calculate(ctx);
    expect(result.rawValue).toBe(10);
    expect(result.detail.matched).toBe("none");
  });

  it("edge case: null occupation scores defaultScore without throwing", async () => {
    const ctx = buildContext(RiskFactorType.OCCUPATION, DEFAULT_CONFIG, {
      customer: { occupation: null },
    });
    const result = await factor.calculate(ctx);
    expect(result.rawValue).toBe(10);
    expect(result.detail.occupation).toBeNull();
  });

  it("edge case: keyword matching is case-insensitive", async () => {
    const ctx = buildContext(RiskFactorType.OCCUPATION, DEFAULT_CONFIG, {
      customer: { occupation: "GAMBLING consultant" },
    });
    const result = await factor.calculate(ctx);
    expect(result.rawValue).toBe(60);
  });

  it("edge case: high-risk keywords take priority over medium-risk keywords", async () => {
    // Contains both a high-risk ("dealer") and medium-risk ("trader") keyword.
    const ctx = buildContext(RiskFactorType.OCCUPATION, DEFAULT_CONFIG, {
      customer: { occupation: "Jewelry dealer and trader" },
    });
    const result = await factor.calculate(ctx);
    expect(result.rawValue).toBe(60);
    expect(result.detail.matched).toBe("high");
  });

  it("config variation: weight proportionally scales contributedScore", async () => {
    const ctx = buildContext(RiskFactorType.OCCUPATION, DEFAULT_CONFIG, {
      customer: { occupation: "Contractor" },
      weight: 2,
    });
    const result = await factor.calculate(ctx);
    expect(result.rawValue).toBe(30);
    expect(result.contributedScore).toBe(60);
  });

  it("edge case: a config missing all optional keys falls back to safe defaults (empty lists, 0 scores)", async () => {
    const ctx = buildContext(RiskFactorType.OCCUPATION, {}, { customer: { occupation: "Anything at all" } });
    const result = await factor.calculate(ctx);
    expect(result.rawValue).toBe(0);
    expect(result.detail.matched).toBe("none");
  });

  it("edge case: a keyword match with no configured score for that tier falls back to defaultScore", async () => {
    const ctx = buildContext(
      RiskFactorType.OCCUPATION,
      { highRiskKeywords: ["gambling"], mediumRiskKeywords: ["trader"], defaultScore: 10 },
      { customer: { occupation: "Gambling operator" } },
    );
    const result = await factor.calculate(ctx);
    expect(result.rawValue).toBe(10);

    const mediumCtx = buildContext(
      RiskFactorType.OCCUPATION,
      { highRiskKeywords: ["gambling"], mediumRiskKeywords: ["trader"], defaultScore: 10 },
      { customer: { occupation: "Commodity trader" } },
    );
    const mediumResult = await factor.calculate(mediumCtx);
    expect(mediumResult.rawValue).toBe(10);
  });

  it("determinism: identical input produces identical output across repeated calls", async () => {
    const ctx = buildContext(RiskFactorType.OCCUPATION, DEFAULT_CONFIG, {
      customer: { occupation: "Teacher" },
    });
    const first = await factor.calculate(ctx);
    const second = await factor.calculate(ctx);
    expect(second).toEqual(first);
  });
});
