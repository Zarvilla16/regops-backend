import { RiskFactorType } from "@regops/shared";
import { contribute, RiskFactor, RiskFactorContext, RiskFactorResult } from "../types";

/**
 * config: { fatfBlacklist: string[], fatfGreylist: string[], highRisk: string[], default: number }
 * Applies to both customer.country and customer.nationality; takes the higher of the two scores.
 * Unknown/unlisted codes fall through to `default`.
 */
export class CountryFactor implements RiskFactor {
  readonly type = RiskFactorType.COUNTRY;

  private scoreFor(code: string, config: { fatfBlacklist?: string[]; fatfGreylist?: string[]; highRisk?: string[]; default?: number }): number {
    if ((config.fatfBlacklist ?? []).includes(code)) return 100;
    if ((config.fatfGreylist ?? []).includes(code)) return 60;
    if ((config.highRisk ?? []).includes(code)) return 40;
    return config.default ?? 0;
  }

  async calculate(ctx: RiskFactorContext): Promise<RiskFactorResult> {
    const config = ctx.config.config as {
      fatfBlacklist?: string[];
      fatfGreylist?: string[];
      highRisk?: string[];
      default?: number;
    };

    const countryScore = this.scoreFor(ctx.customer.country, config);
    const nationalityScore = ctx.customer.nationality ? this.scoreFor(ctx.customer.nationality, config) : null;
    const rawValue = Math.max(countryScore, nationalityScore ?? 0);

    return contribute(this.type, rawValue, ctx.config.weight, {
      country: ctx.customer.country,
      countryScore,
      nationality: ctx.customer.nationality,
      nationalityScore,
    });
  }
}
