import { RiskFactorType } from "@regops/shared";
import { contribute, RiskFactor, RiskFactorContext, RiskFactorResult } from "../types";

/** Inverse relationship — lower KYC tier means less verification, so higher risk. config.scores: { "1": 30, "2": 15, "3": 0 }. */
export class KycTierFactor implements RiskFactor {
  readonly type = RiskFactorType.KYC_TIER;

  async calculate(ctx: RiskFactorContext): Promise<RiskFactorResult> {
    const scores = (ctx.config.config.scores ?? {}) as Record<string, number>;
    const rawValue = scores[String(ctx.customer.kycTier)] ?? 0;

    return contribute(this.type, rawValue, ctx.config.weight, { kycTier: ctx.customer.kycTier });
  }
}
