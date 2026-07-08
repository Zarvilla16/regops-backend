import { RiskFactorType } from "@regops/shared";
import { contribute, RiskFactor, RiskFactorContext, RiskFactorResult } from "../types";

/**
 * Real shape TBD when the Transactions module (Prompt 4) lands — this
 * factor's constructor takes an optional adapter rather than a NestJS
 * `@Optional() @Inject()` token, since this package has no NestJS
 * dependency (it must run standalone inside the CSV ingestion worker
 * process too, not just apps/api).
 */
export interface TransactionVelocityAdapter {
  getStats(customerId: string): Promise<{ score: number; detail: Record<string, unknown> }>;
}

/**
 * Gracefully returns rawValue=0 until the Transactions module registers a
 * real adapter (Prompt 4). Register this factor in the registry regardless
 * — the registry only iterates factors that are actually present, so a
 * missing adapter today doesn't change wiring later.
 */
export class TransactionVelocityFactor implements RiskFactor {
  readonly type = RiskFactorType.TRANSACTION_VELOCITY;

  constructor(private readonly adapter?: TransactionVelocityAdapter) {}

  async calculate(ctx: RiskFactorContext): Promise<RiskFactorResult> {
    if (!this.adapter) {
      return contribute(this.type, 0, ctx.config.weight, { skipped: "transactions_module_not_loaded" });
    }

    // Real implementation arrives in Prompt 4: 30-day rolling average vs.
    // current 7-day stats, spike/dormancy-reactivation detection, scored
    // 0-50 based on ctx.config.config thresholds.
    const { score, detail } = await this.adapter.getStats(ctx.customerId);
    return contribute(this.type, score, ctx.config.weight, detail);
  }
}
