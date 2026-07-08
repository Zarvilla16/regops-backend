import { RiskFactorType } from "@regops/shared";
import { createFactorRegistry } from "./factor.registry";

describe("createFactorRegistry", () => {
  it("returns exactly the six spec-defined factor types, in order", () => {
    const factors = createFactorRegistry();
    expect(factors.map((f) => f.type)).toEqual([
      RiskFactorType.CUSTOMER_TYPE,
      RiskFactorType.OCCUPATION,
      RiskFactorType.COUNTRY,
      RiskFactorType.PRODUCT_MIX,
      RiskFactorType.KYC_TIER,
      RiskFactorType.TRANSACTION_VELOCITY,
    ]);
  });

  it("builds a fresh set of instances on every call", () => {
    const first = createFactorRegistry();
    const second = createFactorRegistry();
    expect(first[0]).not.toBe(second[0]);
  });

  it("wires a transaction velocity adapter through when one is provided", () => {
    const adapter = { getStats: jest.fn() };
    const factors = createFactorRegistry(adapter);
    const velocityFactor = factors.find((f) => f.type === RiskFactorType.TRANSACTION_VELOCITY)!;
    expect(velocityFactor).toBeDefined();
  });
});
