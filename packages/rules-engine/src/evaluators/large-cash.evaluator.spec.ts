import { CustomerType, TransactionChannel, TransactionType } from "@regops/shared";
import { evaluateLargeCash } from "./large-cash.evaluator";
import { EvaluationContext } from "../types";

const NOW = new Date("2026-07-01T12:00:00Z");

function ctx(overrides: Partial<EvaluationContext["transaction"]> = {}, customerType: CustomerType = CustomerType.INDIVIDUAL, isPep = false): EvaluationContext {
  return {
    tenantId: "tenant-1",
    now: NOW,
    customer: {
      id: "cust-1",
      fullName: "John Doe",
      customerType,
      isPep,
      isSanctioned: false,
      onboardedAt: new Date("2020-01-01"),
    },
    transaction: {
      id: "txn-1",
      customerId: "cust-1",
      amount: "0",
      currency: "NGN",
      type: TransactionType.CREDIT,
      channel: TransactionChannel.CASH,
      counterpartyAccount: null,
      counterpartyBank: null,
      counterpartyName: null,
      counterpartyCustomerId: null,
      occurredAt: NOW,
      ...overrides,
    },
  };
}

describe("evaluateLargeCash", () => {
  it("fires on a 6M cash CREDIT for an INDIVIDUAL (5M threshold)", () => {
    const result = evaluateLargeCash(ctx({ amount: "6000000" }), {});
    expect(result.fired).toBe(true);
    expect(result.evidence?.relatedTransactionIds).toEqual(["txn-1"]);
  });

  it("does not fire on a 4M cash CREDIT for an INDIVIDUAL", () => {
    expect(evaluateLargeCash(ctx({ amount: "4000000" }), {}).fired).toBe(false);
  });

  it("does not fire on a 6M cash CREDIT for an SME (10M threshold)", () => {
    expect(evaluateLargeCash(ctx({ amount: "6000000" }, CustomerType.SME), {}).fired).toBe(false);
  });

  it("fires on a 12M cash CREDIT for an SME", () => {
    const result = evaluateLargeCash(ctx({ amount: "12000000" }, CustomerType.SME), {});
    expect(result.fired).toBe(true);
  });

  it("does not fire on a 20M MOBILE transfer (not CASH channel)", () => {
    const result = evaluateLargeCash(ctx({ amount: "20000000", channel: TransactionChannel.MOBILE }), {});
    expect(result.fired).toBe(false);
  });

  it("uses the individual threshold for a PEP customer even if flagged CORPORATE", () => {
    const result = evaluateLargeCash(ctx({ amount: "6000000" }, CustomerType.CORPORATE, true), {});
    expect(result.fired).toBe(true);
    expect(result.evidence?.facts.thresholdApplied).toBe(5_000_000);
  });

  it("respects excludedChannels config", () => {
    const result = evaluateLargeCash(ctx({ amount: "6000000" }), { excludedChannels: [TransactionChannel.CASH] });
    expect(result.fired).toBe(false);
  });

  it("does not fire on a non-NGN cash transaction, even above threshold (v1 is NGN-only)", () => {
    const result = evaluateLargeCash(ctx({ amount: "7000000", currency: "USD" }), {});
    expect(result.fired).toBe(false);
  });
});
