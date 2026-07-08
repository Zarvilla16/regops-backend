import { RiskFactorType } from "@regops/shared";
import { TransactionVelocityAdapter, TransactionVelocityFactor } from "./transaction-velocity.factor";
import { buildContext } from "../test-utils";

describe("TransactionVelocityFactor", () => {
  it("happy path: with no adapter registered (Prompt 4 not yet loaded), gracefully returns rawValue=0", async () => {
    const factor = new TransactionVelocityFactor();
    const ctx = buildContext(RiskFactorType.TRANSACTION_VELOCITY, { maxScore: 50 });
    const result = await factor.calculate(ctx);
    expect(result.rawValue).toBe(0);
    expect(result.contributedScore).toBe(0);
    expect(result.detail.skipped).toBe("transactions_module_not_loaded");
  });

  it("edge case: delegates to a registered adapter when one is provided", async () => {
    const adapter: TransactionVelocityAdapter = {
      getStats: jest.fn().mockResolvedValue({ score: 42, detail: { spike: true } }),
    };
    const factor = new TransactionVelocityFactor(adapter);
    const ctx = buildContext(RiskFactorType.TRANSACTION_VELOCITY, { maxScore: 50 });

    const result = await factor.calculate(ctx);

    expect(adapter.getStats).toHaveBeenCalledWith(ctx.customerId);
    expect(result.rawValue).toBe(42);
    expect(result.detail).toEqual({ spike: true });
  });

  it("config variation: weight proportionally scales contributedScore when an adapter is present", async () => {
    const adapter: TransactionVelocityAdapter = {
      getStats: jest.fn().mockResolvedValue({ score: 20, detail: {} }),
    };
    const factor = new TransactionVelocityFactor(adapter);
    const ctx = buildContext(RiskFactorType.TRANSACTION_VELOCITY, {}, { weight: 1.5 });

    const result = await factor.calculate(ctx);

    expect(result.rawValue).toBe(20);
    expect(result.contributedScore).toBe(30);
  });

  it("determinism: identical input (no adapter) produces identical output across repeated calls", async () => {
    const factor = new TransactionVelocityFactor();
    const ctx = buildContext(RiskFactorType.TRANSACTION_VELOCITY, {});
    const first = await factor.calculate(ctx);
    const second = await factor.calculate(ctx);
    expect(second).toEqual(first);
  });
});
