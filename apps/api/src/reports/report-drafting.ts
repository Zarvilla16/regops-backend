import { TransactionChannel } from "@regops/shared";

/**
 * Pure (no DI, no DB) helpers that compute a Report's auto-drafted
 * `flaggedAmount` / `narrative` (Backend Prompt 7, Section 2.5). Deliberately
 * a plain module rather than a provider: CasesService calls these while
 * creating the SAR draft inside its own approve() transaction, and
 * ReportsService/CtrGenerationListener call them for CTRs — a provider here
 * would force a CasesModule <-> ReportsModule circular import for no benefit.
 */

export interface DraftNote {
  at: Date;
  authorName: string;
  content: string;
}

/** Decimal-string amounts summed in integer kobo, so 0.1 + 0.2 style float drift never reaches a regulatory figure. */
export function sumAmounts(amounts: string[]): string {
  const kobo = amounts.reduce((sum, a) => sum + Math.round(Number(a) * 100), 0);
  return (kobo / 100).toFixed(2);
}

/** Section 2.5 (SAR): deduplicated sum of the case's linked-alert transactions. Callers pass the
 * already-deduplicated list from CasesService.getDerivedTransactions(); null when there are none
 * (matches the frontend mock's sumFlaggedTransactionAmounts). */
export function computeSarFlaggedAmount(transactions: { amount: string }[]): string | null {
  if (transactions.length === 0) return null;
  return sumAmounts(transactions.map((t) => t.amount));
}

function stamp(d: Date): string {
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

/** Section 2.5 (SAR): investigation notes (chronological) followed by the escalation rationale — a starting point, not a finished narrative. */
export function buildSarNarrative(params: { caseNumber: string; notes: DraftNote[]; escalationRationale: string | null }): string {
  const parts: string[] = [`Suspicious activity report for case ${params.caseNumber}.`];

  if (params.notes.length > 0) {
    const sorted = [...params.notes].sort((a, b) => a.at.getTime() - b.at.getTime());
    parts.push("Investigation notes:\n" + sorted.map((n) => `- [${stamp(n.at)}] ${n.authorName}: ${n.content}`).join("\n"));
  }
  if (params.escalationRationale) {
    parts.push(`Escalation rationale:\n${params.escalationRationale}`);
  }
  return parts.join("\n\n");
}

export function formatNaira(amount: string | number): string {
  return `₦${Number(amount).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Section 2.5 (CTR): a short factual description — a CTR is a routine mandatory filing, not a suspicion narrative. */
export function buildCtrNarrative(params: {
  amount: string;
  customerName: string;
  occurredAt: Date;
  channel: TransactionChannel;
  threshold: number;
}): string {
  return (
    `Cash transaction of ${formatNaira(params.amount)} by ${params.customerName} on ${params.occurredAt.toISOString().slice(0, 10)} ` +
    `via ${params.channel}, exceeding the ${formatNaira(params.threshold)} reporting threshold.`
  );
}
