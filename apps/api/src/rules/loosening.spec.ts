import { detectLoosening } from "./loosening";

describe("detectLoosening", () => {
  it("flags raising a threshold as loosening", () => {
    const result = detectLoosening({ thresholdIndividual: 5_000_000 }, { thresholdIndividual: 8_000_000 });
    expect(result.isLoosening).toBe(true);
    expect(result.changedKeys).toEqual(["thresholdIndividual"]);
  });

  it("does not flag lowering a threshold as loosening", () => {
    const result = detectLoosening({ thresholdIndividual: 5_000_000 }, { thresholdIndividual: 3_000_000 });
    expect(result.isLoosening).toBe(false);
  });

  it("flags shrinking the structuring window as loosening (inverse-direction key)", () => {
    const result = detectLoosening({ windowHours: 24 }, { windowHours: 6 });
    expect(result.isLoosening).toBe(true);
  });

  it("does not flag growing the window as loosening", () => {
    const result = detectLoosening({ windowHours: 24 }, { windowHours: 48 });
    expect(result.isLoosening).toBe(false);
  });

  it("ignores keys not present in the incoming config", () => {
    const result = detectLoosening({ thresholdIndividual: 5_000_000, minCount: 3 }, { minCount: 5 });
    expect(result.changedKeys).toEqual(["minCount"]);
  });

  it("ignores non-sensitivity keys entirely", () => {
    const result = detectLoosening({ applyToCredit: true }, { applyToCredit: false });
    expect(result.isLoosening).toBe(false);
  });

  it("ignores an unchanged value even if the key is a sensitivity dial", () => {
    const result = detectLoosening({ minCount: 3 }, { minCount: 3 });
    expect(result.isLoosening).toBe(false);
  });
});
