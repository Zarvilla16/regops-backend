import { CustomerType, TransactionChannel, TransactionType } from "@regops/shared";
import { EvaluationContext, EvaluationResult } from "../types";

export interface LargeCashConfig {
  thresholdIndividual?: number;
  thresholdCorporate?: number;
  applyToCredit?: boolean;
  applyToDebit?: boolean;
  excludedChannels?: string[];
}

/** Section 6.1: single cash transaction above the CBN CTR threshold. Fires
 * (almost) once per qualifying transaction — dedupKey is per-transaction, not
 * a real dedup window, so every crossing becomes its own CTR-feeding Alert
 * (Prompt 7). PEP customers always use the lower (individual) threshold
 * regardless of their actual customer_type, per the spec's own edge case. */
export function evaluateLargeCash(ctx: EvaluationContext, config: LargeCashConfig): EvaluationResult {
  const { transaction, customer } = ctx;

  if (transaction.channel !== TransactionChannel.CASH) return { fired: false };
  // Section 6.1 edge case: only NGN counts in v1 — foreign-currency cash
  // transactions are not flagged here (a separate v2 scenario).
  if (transaction.currency !== "NGN") return { fired: false };
  if (config.excludedChannels?.includes(transaction.channel)) return { fired: false };
  if (transaction.type === TransactionType.CREDIT && config.applyToCredit === false) return { fired: false };
  if (transaction.type === TransactionType.DEBIT && config.applyToDebit === false) return { fired: false };

  const thresholdIndividual = config.thresholdIndividual ?? 5_000_000;
  const thresholdCorporate = config.thresholdCorporate ?? 10_000_000;
  const usesIndividualThreshold = customer.customerType === CustomerType.INDIVIDUAL || customer.isPep;
  const threshold = usesIndividualThreshold ? thresholdIndividual : thresholdCorporate;

  const amount = Number(transaction.amount);
  if (amount < threshold) return { fired: false };

  return {
    fired: true,
    dedupKey: `large_cash:${customer.id}:${transaction.id}`,
    evidence: {
      summary: `Cash ${transaction.type} of NGN ${amount.toLocaleString("en-NG")} by ${customer.fullName}`,
      facts: {
        amount,
        type: transaction.type,
        customerType: customer.customerType,
        thresholdApplied: threshold,
        channel: transaction.channel,
        transactionReference: transaction.id,
      },
      relatedTransactionIds: [transaction.id],
    },
  };
}
