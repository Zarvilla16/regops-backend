import { dayBucket } from "../dedup";
import { EvaluationContext, EvaluationResult } from "../types";

export interface VelocitySpikeConfig {
  minSpikeRatio?: number;
  minAbsoluteAmount?: number;
  excludeNewCustomersDays?: number;
  /** Below this many days of transaction history in the rolling window, a
   * literal spike ratio is unreliable (divide-by-near-zero) — Section 6.5's
   * edge case instead treats the situation as a dormancy reactivation. */
  minHistoricalDays?: number;
  dormancyReactivationMinDays?: number;
}

export interface VelocityRawStats {
  /** Mean of daily totals over the rolling window, excluding today. */
  rollingDailyAvg: number;
  todayTotal: number;
  todayCount: number;
  /** Number of distinct days with activity in the rolling window (excluding today). */
  historicalDayCount: number;
  /** Days since the customer's most recent transaction before today, or the
   * window size if there was no prior activity at all in the queried window. */
  dormancyDays: number;
  /** True only if the query window contains at least one transaction on a day
   * other than today. False for a customer whose very first transaction ever
   * (in the queried window) is today's — that case must NOT be treated as a
   * "dormancy reactivation" (there is no established behavior being resumed,
   * so `dormancyDays` falling back to the full window size is not a real
   * signal — see HANDOFF.md's Prompt 5 bug list). */
  hasPriorActivityInWindow: boolean;
  customerAgeDays: number;
}

/** Section 6.5. */
export function evaluateVelocitySpike(
  ctx: EvaluationContext,
  config: VelocitySpikeConfig,
  stats: VelocityRawStats,
): EvaluationResult {
  const minSpikeRatio = config.minSpikeRatio ?? 5.0;
  const minAbsoluteAmount = config.minAbsoluteAmount ?? 1_000_000;
  const excludeNewCustomersDays = config.excludeNewCustomersDays ?? 30;
  const minHistoricalDays = config.minHistoricalDays ?? 5;
  const dormancyReactivationMinDays = config.dormancyReactivationMinDays ?? 30;

  if (stats.customerAgeDays < excludeNewCustomersDays) return { fired: false };
  if (stats.todayTotal < minAbsoluteAmount) return { fired: false };

  let spikeRatio: number | null;
  let isDormancyReactivation = false;

  if (stats.historicalDayCount >= minHistoricalDays && stats.rollingDailyAvg > 0) {
    spikeRatio = stats.todayTotal / stats.rollingDailyAvg;
    if (spikeRatio < minSpikeRatio) return { fired: false };
  } else {
    // Too little baseline to compute a meaningful ratio (spec's "rolling_30d_avg
    // has at least min_transactions" guard) — only fire if this reads as a
    // genuine dormancy reactivation, not just a sparse-but-normal new-ish account,
    // and only if there's actual evidence of prior activity to be "reactivating"
    // from (otherwise this is just an established-but-never-transacted customer's
    // first movement, not a resumption of a known pattern).
    if (!stats.hasPriorActivityInWindow) return { fired: false };
    if (stats.dormancyDays < dormancyReactivationMinDays) return { fired: false };
    isDormancyReactivation = true;
    spikeRatio = null;
  }

  return {
    fired: true,
    dedupKey: `velocity:${ctx.customer.id}:${dayBucket(ctx.now)}`,
    evidence: {
      summary: isDormancyReactivation
        ? `Daily transaction volume NGN ${stats.todayTotal.toLocaleString("en-NG")} follows ${stats.dormancyDays} days of dormancy`
        : `Daily transaction volume NGN ${stats.todayTotal.toLocaleString("en-NG")} is ${spikeRatio!.toFixed(1)}x customer's rolling average`,
      facts: {
        todayTotal: stats.todayTotal,
        todayCount: stats.todayCount,
        rolling30dAvg: stats.rollingDailyAvg,
        spikeRatio,
        dormancyDays: stats.dormancyDays,
        isDormancyReactivation,
        historicalDayCount: stats.historicalDayCount,
      },
      relatedTransactionIds: [ctx.transaction.id],
    },
  };
}
