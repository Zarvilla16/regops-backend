import { CustomerType, TransactionChannel, TransactionType } from "@regops/shared";
import { dayBucket } from "../dedup";
import { EvaluationContext, EvaluationResult } from "../types";

export interface StructuringConfig {
  windowHours?: number;
  minCount?: number;
  cumulativeThreshold?: number;
  sameDirectionOnly?: boolean;
  /** Mirrors LARGE_CASH's own thresholds so this evaluator can apply the
   * "already covered by Large Cash" exclusion (Section 6.2 edge case)
   * without a cross-scenario config lookup. */
  largeCashThresholdIndividual?: number;
  largeCashThresholdCorporate?: number;
}

export interface RecentCashTransaction {
  id: string;
  amount: number;
  type: TransactionType;
  occurredAt: Date;
}

/**
 * Section 6.2. `recentCashTxns` must already be pre-filtered by the caller to
 * exactly: same tenant + customer, channel = CASH, occurred_at within
 * [now - windowHours, now] — including the current transaction itself. This
 * evaluator does no DB access; the fact-gathering query lives in
 * packages/db/src/queries/rule-facts.ts.
 */
export function evaluateStructuring(
  ctx: EvaluationContext,
  config: StructuringConfig,
  recentCashTxns: RecentCashTransaction[],
): EvaluationResult {
  if (ctx.transaction.channel !== TransactionChannel.CASH) return { fired: false };

  const windowHours = config.windowHours ?? 24;
  const minCount = config.minCount ?? 3;
  const cumulativeThreshold = config.cumulativeThreshold ?? 5_000_000;
  const sameDirectionOnly = config.sameDirectionOnly ?? false;

  const candidates = sameDirectionOnly
    ? recentCashTxns.filter((t) => t.type === ctx.transaction.type)
    : recentCashTxns;

  // Don't double-alert on the same root pattern: if any single transaction in
  // the window already crosses the Large Cash threshold, that's Scenario 1's
  // alert, not this one.
  const usesIndividualThreshold = ctx.customer.customerType === CustomerType.INDIVIDUAL || ctx.customer.isPep;
  const largeCashThreshold = usesIndividualThreshold
    ? (config.largeCashThresholdIndividual ?? 5_000_000)
    : (config.largeCashThresholdCorporate ?? 10_000_000);
  if (candidates.some((t) => t.amount >= largeCashThreshold)) return { fired: false };

  const count = candidates.length;
  const cumulativeAmount = candidates.reduce((sum, t) => sum + t.amount, 0);
  if (count < minCount || cumulativeAmount < cumulativeThreshold) return { fired: false };

  const sorted = [...candidates].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

  return {
    fired: true,
    dedupKey: `structuring:${ctx.customer.id}:${dayBucket(ctx.now)}`,
    evidence: {
      summary: `${count} cash transactions totalling NGN ${cumulativeAmount.toLocaleString("en-NG")} within ${windowHours}h by ${ctx.customer.fullName}`,
      facts: {
        txnCount: count,
        cumulativeAmount,
        windowHours,
        amounts: sorted.map((t) => t.amount),
        types: sorted.map((t) => t.type),
        firstAt: sorted[0]?.occurredAt.toISOString() ?? null,
        lastAt: sorted[sorted.length - 1]?.occurredAt.toISOString() ?? null,
      },
      relatedTransactionIds: sorted.map((t) => t.id),
    },
  };
}
