import { RiskFactorType } from "@regops/shared";
import { contribute, RiskFactor, RiskFactorContext, RiskFactorResult } from "../types";

/** config.scores: Record<CustomerType, number> — see default-configs.ts for the seeded defaults. */
export class CustomerTypeFactor implements RiskFactor {
  readonly type = RiskFactorType.CUSTOMER_TYPE;

  async calculate(ctx: RiskFactorContext): Promise<RiskFactorResult> {
    const scores = (ctx.config.config.scores ?? {}) as Record<string, number>;
    const rawValue = scores[ctx.customer.customerType] ?? 0;

    return contribute(this.type, rawValue, ctx.config.weight, {
      customerType: ctx.customer.customerType,
    });
  }
}
