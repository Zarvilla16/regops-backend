import { TransactionChannel, TransactionType } from "@regops/shared";
import { intervalBucket } from "../dedup";
import { EvaluationContext, EvaluationResult } from "../types";

export interface RapidInflowOutflowConfig {
  windowMinutes?: number;
  outflowRatio?: number;
  minInboundAmount?: number;
  excludeInternal?: boolean;
}

export interface RecentCredit {
  id: string;
  amount: number;
  occurredAt: Date;
  counterpartyCustomerId: string | null;
}

const ELIGIBLE_CHANNELS: TransactionChannel[] = [TransactionChannel.TRANSFER, TransactionChannel.MOBILE, TransactionChannel.USSD];

/**
 * Section 6.3. `recentCredits` must already be pre-filtered by the caller to:
 * same tenant + customer, type = CREDIT, channel in TRANSFER/MOBILE/USSD,
 * occurred_at within [transaction.occurredAt - windowMinutes, transaction.occurredAt].
 */
export function evaluateRapidInflowOutflow(
  ctx: EvaluationContext,
  config: RapidInflowOutflowConfig,
  recentCredits: RecentCredit[],
): EvaluationResult {
  const tx = ctx.transaction;
  if (tx.type !== TransactionType.DEBIT) return { fired: false };
  if (!ELIGIBLE_CHANNELS.includes(tx.channel)) return { fired: false };

  const windowMinutes = config.windowMinutes ?? 60;
  const outflowRatio = config.outflowRatio ?? 0.8;
  const minInboundAmount = config.minInboundAmount ?? 500_000;
  const excludeInternal = config.excludeInternal ?? true;

  if (recentCredits.length === 0) return { fired: false };

  const totalInbound = recentCredits.reduce((sum, c) => sum + c.amount, 0);
  if (totalInbound < minInboundAmount) return { fired: false };

  const outboundAmount = Number(tx.amount);
  if (outboundAmount < totalInbound * outflowRatio) return { fired: false };

  // Section 6.3 edge case: both legs internal (known counterparties) ->
  // lower risk, eliminates the most common false positive.
  const allInternal = Boolean(tx.counterpartyCustomerId) && recentCredits.every((c) => Boolean(c.counterpartyCustomerId));
  if (excludeInternal && allInternal) return { fired: false };

  const passThroughRatio = totalInbound > 0 ? outboundAmount / totalInbound : 0;
  const earliestCredit = [...recentCredits].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())[0];
  const actualWindowMinutes = earliestCredit
    ? Math.round((tx.occurredAt.getTime() - earliestCredit.occurredAt.getTime()) / 60_000)
    : 0;

  return {
    fired: true,
    dedupKey: `rapid_io:${ctx.customer.id}:${intervalBucket(ctx.now, windowMinutes)}`,
    evidence: {
      summary: `NGN ${outboundAmount.toLocaleString("en-NG")} outbound ${actualWindowMinutes}min after NGN ${totalInbound.toLocaleString("en-NG")} inbound (${Math.round(passThroughRatio * 100)}% pass-through)`,
      facts: {
        inboundAmount: totalInbound,
        outboundAmount,
        passThroughRatio,
        windowMinutes: actualWindowMinutes,
        inboundTransactionCount: recentCredits.length,
        allInternal,
      },
      relatedTransactionIds: [...recentCredits.map((c) => c.id), tx.id],
    },
  };
}
