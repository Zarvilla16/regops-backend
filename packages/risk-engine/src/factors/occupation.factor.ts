import { RiskFactorType } from "@regops/shared";
import { contribute, RiskFactor, RiskFactorContext, RiskFactorResult } from "../types";

/**
 * config: { highRiskKeywords: string[], highRiskScore, mediumRiskKeywords: string[],
 * mediumRiskScore, defaultScore } — keyword matching is a case-insensitive substring
 * check against the customer's occupation string.
 */
export class OccupationFactor implements RiskFactor {
  readonly type = RiskFactorType.OCCUPATION;

  async calculate(ctx: RiskFactorContext): Promise<RiskFactorResult> {
    const config = ctx.config.config as {
      highRiskKeywords?: string[];
      highRiskScore?: number;
      mediumRiskKeywords?: string[];
      mediumRiskScore?: number;
      defaultScore?: number;
    };
    const defaultScore = config.defaultScore ?? 0;

    if (!ctx.customer.occupation) {
      return contribute(this.type, defaultScore, ctx.config.weight, { occupation: null, matched: "none" });
    }

    const occupation = ctx.customer.occupation.toLowerCase();
    const highRiskKeyword = (config.highRiskKeywords ?? []).find((k) => occupation.includes(k.toLowerCase()));
    if (highRiskKeyword) {
      return contribute(this.type, config.highRiskScore ?? defaultScore, ctx.config.weight, {
        occupation: ctx.customer.occupation,
        matched: "high",
        keyword: highRiskKeyword,
      });
    }

    const mediumRiskKeyword = (config.mediumRiskKeywords ?? []).find((k) => occupation.includes(k.toLowerCase()));
    if (mediumRiskKeyword) {
      return contribute(this.type, config.mediumRiskScore ?? defaultScore, ctx.config.weight, {
        occupation: ctx.customer.occupation,
        matched: "medium",
        keyword: mediumRiskKeyword,
      });
    }

    return contribute(this.type, defaultScore, ctx.config.weight, {
      occupation: ctx.customer.occupation,
      matched: "none",
    });
  }
}
