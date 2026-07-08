import { CustomerType, RiskFactorType } from "@regops/shared";
import { CustomerTypeFactor } from "./customer-type.factor";
import { buildContext } from "../test-utils";

const DEFAULT_SCORES = { GOVERNMENT: 10, INDIVIDUAL: 20, SME: 30, CORPORATE: 40, NGO: 60, PEP: 80 };

describe("CustomerTypeFactor", () => {
  const factor = new CustomerTypeFactor();

  it("happy path: each customer type maps to its configured score", async () => {
    for (const [type, expected] of Object.entries(DEFAULT_SCORES)) {
      const ctx = buildContext(RiskFactorType.CUSTOMER_TYPE, { scores: DEFAULT_SCORES }, {
        customer: { customerType: type as CustomerType },
      });
      const result = await factor.calculate(ctx);
      expect(result.rawValue).toBe(expected);
      expect(result.contributedScore).toBe(expected);
    }
  });

  it("edge case: a customer type missing from config.scores defaults to 0", async () => {
    const ctx = buildContext(RiskFactorType.CUSTOMER_TYPE, { scores: { INDIVIDUAL: 20 } }, {
      customer: { customerType: CustomerType.PEP },
    });
    const result = await factor.calculate(ctx);
    expect(result.rawValue).toBe(0);
  });

  it("edge case: a config with no scores key at all defaults to 0 rather than throwing", async () => {
    const ctx = buildContext(RiskFactorType.CUSTOMER_TYPE, {}, {
      customer: { customerType: CustomerType.SME },
    });
    const result = await factor.calculate(ctx);
    expect(result.rawValue).toBe(0);
  });

  it("config variation: weight proportionally scales contributedScore", async () => {
    const ctx = buildContext(RiskFactorType.CUSTOMER_TYPE, { scores: DEFAULT_SCORES }, {
      customer: { customerType: CustomerType.SME },
      weight: 0.5,
    });
    const result = await factor.calculate(ctx);
    expect(result.rawValue).toBe(30);
    expect(result.contributedScore).toBe(15);
  });

  it("determinism: identical input produces identical output across repeated calls", async () => {
    const ctx = buildContext(RiskFactorType.CUSTOMER_TYPE, { scores: DEFAULT_SCORES }, {
      customer: { customerType: CustomerType.CORPORATE },
    });
    const first = await factor.calculate(ctx);
    const second = await factor.calculate(ctx);
    expect(second).toEqual(first);
  });
});
