import { AlertSeverity, TransactionType } from "@regops/shared";
import { dayBucket } from "../dedup";
import { EvaluationContext, EvaluationResult } from "../types";

export interface HighRiskCounterpartyConfig {
  skipBelowAmount?: number;
  pepSeverity?: AlertSeverity;
  sanctionsSeverity?: AlertSeverity;
}

/** Result of resolving the transaction's counterparty — either an internal
 * customer's flags looked up directly (no external call), or an external
 * screening result (cached or freshly screened). Caller (CounterpartyScreeningService,
 * apps/api) is responsible for producing this; `null` means the transaction
 * has no counterparty to screen at all (e.g. no counterparty_account/name). */
export interface CounterpartyScreeningFacts {
  isInternal: boolean;
  isSanctioned: boolean;
  isPep: boolean;
  matchSource: string | null;
  matchScore: number | null;
  screeningCheckId: string | null;
}

/** Section 6.4. */
export function evaluateHighRiskCounterparty(
  ctx: EvaluationContext,
  config: HighRiskCounterpartyConfig,
  screening: CounterpartyScreeningFacts | null,
): EvaluationResult {
  if (!screening) return { fired: false };

  const skipBelowAmount = config.skipBelowAmount ?? 10_000;
  if (Number(ctx.transaction.amount) < skipBelowAmount) return { fired: false };

  if (!screening.isSanctioned && !screening.isPep) return { fired: false };

  const severity = screening.isSanctioned
    ? (config.sanctionsSeverity ?? AlertSeverity.CRITICAL)
    : (config.pepSeverity ?? AlertSeverity.MEDIUM);
  const direction = ctx.transaction.type === TransactionType.DEBIT ? "OUTBOUND" : "INBOUND";
  const matchSourceLabel = screening.isSanctioned ? "sanctions list" : "PEP database";

  return {
    fired: true,
    severity,
    dedupKey: `counterparty:${ctx.customer.id}:${ctx.transaction.counterpartyAccount ?? ctx.transaction.counterpartyCustomerId ?? "unknown"}:${dayBucket(ctx.now)}`,
    evidence: {
      summary: `Transfer ${direction === "OUTBOUND" ? "to" : "from"} counterparty matching ${matchSourceLabel}${screening.matchScore != null ? ` (${screening.matchScore}% match)` : ""}`,
      facts: {
        counterpartyName: ctx.transaction.counterpartyName,
        counterpartyAccount: ctx.transaction.counterpartyAccount,
        counterpartyBank: ctx.transaction.counterpartyBank,
        matchSource: screening.matchSource,
        matchScore: screening.matchScore,
        screeningCheckId: screening.screeningCheckId,
        isInternalCounterparty: screening.isInternal,
        direction,
      },
      relatedTransactionIds: [ctx.transaction.id],
    },
  };
}
