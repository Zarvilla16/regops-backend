import { RiskFactorType } from "@regops/shared";
import { ProductMixFactor } from "./product-mix.factor";
import { buildContext } from "../test-utils";

describe("ProductMixFactor", () => {
  const factor = new ProductMixFactor();

  it("happy path: always scores 0 and marks itself skipped (no product usage data yet)", async () => {
    const ctx = buildContext(RiskFactorType.PRODUCT_MIX, {});
    const result = await factor.calculate(ctx);
    expect(result.rawValue).toBe(0);
    expect(result.contributedScore).toBe(0);
    expect(result.detail.skipped).toBe(true);
  });

  it("edge case: an arbitrary/unrelated config object doesn't change the result", async () => {
    const ctx = buildContext(RiskFactorType.PRODUCT_MIX, { anything: "goes" });
    const result = await factor.calculate(ctx);
    expect(result.rawValue).toBe(0);
  });

  it("config variation: weight has no effect since rawValue is always 0", async () => {
    const ctx = buildContext(RiskFactorType.PRODUCT_MIX, {}, { weight: 5 });
    const result = await factor.calculate(ctx);
    expect(result.contributedScore).toBe(0);
  });

  it("determinism: identical input produces identical output across repeated calls", async () => {
    const ctx = buildContext(RiskFactorType.PRODUCT_MIX, {});
    const first = await factor.calculate(ctx);
    const second = await factor.calculate(ctx);
    expect(second).toEqual(first);
  });
});
