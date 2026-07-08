import { RiskFactorType } from "@regops/shared";
import { contribute, RiskFactor, RiskFactorContext, RiskFactorResult } from "../types";

/** Requires the product usage table from a later phase — scores 0 with detail: { skipped: true } until then. */
export class ProductMixFactor implements RiskFactor {
  readonly type = RiskFactorType.PRODUCT_MIX;

  async calculate(ctx: RiskFactorContext): Promise<RiskFactorResult> {
    return contribute(this.type, 0, ctx.config.weight, { skipped: true });
  }
}
