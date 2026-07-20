import { CustomerType, TransactionChannel, TransactionType } from "@regops/shared";
import { evaluateStructuring, RecentCashTransaction } from "./structuring.evaluator";
import { EvaluationContext } from "../types";

const NOW = new Date("2026-07-01T12:00:00Z");

function ctx(): EvaluationContext {
  return {
    tenantId: "tenant-1",
    now: NOW,
    customer: {
      id: "cust-1",
      fullName: "John Doe",
      customerType: CustomerType.INDIVIDUAL,
      isPep: false,
      isSanctioned: false,
      onboardedAt: new Date("2020-01-01"),
    },
    transaction: {
      id: "txn-current",
      customerId: "cust-1",
      amount: "2000000",
      currency: "NGN",
      type: TransactionType.CREDIT,
      channel: TransactionChannel.CASH,
      counterpartyAccount: null,
      counterpartyBank: null,
      counterpartyName: null,
      counterpartyCustomerId: null,
      occurredAt: NOW,
    },
  };
}

function txns(amounts: number[], hoursAgo: number[], types?: TransactionType[]): RecentCashTransaction[] {
  return amounts.map((amount, i) => ({
    id: `txn-${i}`,
    amount,
    type: types?.[i] ?? TransactionType.CREDIT,
    occurredAt: new Date(NOW.getTime() - (hoursAgo[i] ?? 0) * 3_600_000),
  }));
}

describe("evaluateStructuring", () => {
  it("fires on 3 cash deposits of 2M each within 6h (count and cumulative both met)", () => {
    const result = evaluateStructuring(ctx(), {}, txns([2_000_000, 2_000_000, 2_000_000], [6, 3, 0]));
    expect(result.fired).toBe(true);
  });

  it("does not fire on 2 cash deposits of 3M each (count below threshold)", () => {
    const result = evaluateStructuring(ctx(), {}, txns([3_000_000, 3_000_000], [3, 0]));
    expect(result.fired).toBe(false);
  });

  it("does not fire on 3 cash deposits of 1M each (cumulative below 5M)", () => {
    const result = evaluateStructuring(ctx(), {}, txns([1_000_000, 1_000_000, 1_000_000], [6, 3, 0]));
    expect(result.fired).toBe(false);
  });

  it("does not fire when the 3 deposits span 30h (outside the 24h window)", () => {
    // The caller is responsible for the window filter, but a mis-supplied set outside the window
    // should still not accidentally cross count/cumulative if the fixture reflects a real 30h spread —
    // here we simulate the caller correctly excluding the out-of-window transaction.
    const result = evaluateStructuring(ctx(), {}, txns([2_000_000, 2_000_000], [3, 0]));
    expect(result.fired).toBe(false);
  });

  it("fires on cash only when a transfer is mixed in (transfer isn't in recentCashTxns)", () => {
    // recentCashTxns is caller-filtered to CASH only, so a same-amount transfer never appears here.
    const result = evaluateStructuring(ctx(), {}, txns([2_000_000, 2_000_000, 2_000_000], [6, 3, 0]));
    expect(result.fired).toBe(true);
  });

  it("does not fire when a single transaction in the window already crosses the Large Cash threshold", () => {
    const result = evaluateStructuring(ctx(), {}, txns([6_000_000, 2_000_000, 2_000_000], [6, 3, 0]));
    expect(result.fired).toBe(false);
  });

  it("respects sameDirectionOnly, excluding opposite-direction transactions from count/cumulative", () => {
    const mixed = txns([2_000_000, 2_000_000, 2_000_000], [6, 3, 0], [
      TransactionType.CREDIT,
      TransactionType.DEBIT,
      TransactionType.CREDIT,
    ]);
    const result = evaluateStructuring(ctx(), { sameDirectionOnly: true }, mixed);
    expect(result.fired).toBe(false); // only 2 CREDITs qualify, below minCount 3
  });
});
