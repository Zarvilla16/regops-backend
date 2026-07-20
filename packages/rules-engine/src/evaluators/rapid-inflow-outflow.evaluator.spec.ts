import { CustomerType, TransactionChannel, TransactionType } from "@regops/shared";
import { evaluateRapidInflowOutflow, RecentCredit } from "./rapid-inflow-outflow.evaluator";
import { EvaluationContext } from "../types";

const NOW = new Date("2026-07-01T12:00:00Z");

function ctx(amount: string, minutesAfterCredit: number, counterpartyCustomerId: string | null = null): EvaluationContext {
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
      id: "txn-debit",
      customerId: "cust-1",
      amount,
      currency: "NGN",
      type: TransactionType.DEBIT,
      channel: TransactionChannel.TRANSFER,
      counterpartyAccount: "9876543210",
      counterpartyBank: "XYZBANK",
      counterpartyName: "Jane Roe",
      counterpartyCustomerId,
      occurredAt: new Date(NOW.getTime() + minutesAfterCredit * 60_000),
    },
  };
}

function credit(amount: number, counterpartyCustomerId: string | null = null): RecentCredit {
  return { id: "txn-credit", amount, occurredAt: NOW, counterpartyCustomerId };
}

describe("evaluateRapidInflowOutflow", () => {
  it("fires on 5M inbound, 4.5M outbound within 35min (90% pass-through)", () => {
    const result = evaluateRapidInflowOutflow(ctx("4500000", 35), {}, [credit(5_000_000)]);
    expect(result.fired).toBe(true);
  });

  it("does not fire on 5M inbound, 3M outbound within 35min (60% < 80% ratio)", () => {
    const result = evaluateRapidInflowOutflow(ctx("3000000", 35), {}, [credit(5_000_000)]);
    expect(result.fired).toBe(false);
  });

  it("does not fire on 5M inbound, 4.5M outbound after 90min (outside default 60min window)", () => {
    // Caller is responsible for the window filter — an empty credits array
    // simulates the 90-minute-old credit having been excluded upstream.
    const result = evaluateRapidInflowOutflow(ctx("4500000", 90), {}, []);
    expect(result.fired).toBe(false);
  });

  it("does not fire on 200K inbound, 180K outbound within 10min (inbound below minInboundAmount)", () => {
    const result = evaluateRapidInflowOutflow(ctx("180000", 10), {}, [credit(200_000)]);
    expect(result.fired).toBe(false);
  });

  it("fires on multiple 1M credits aggregated to 5M, then 4.5M outbound (sum-based)", () => {
    const result = evaluateRapidInflowOutflow(ctx("4500000", 35), {}, [
      credit(1_000_000),
      credit(1_000_000),
      credit(1_000_000),
      credit(1_000_000),
      credit(1_000_000),
    ]);
    expect(result.fired).toBe(true);
  });

  it("does not fire when both legs are internal customers and excludeInternal is true", () => {
    const result = evaluateRapidInflowOutflow(ctx("4500000", 35, "cust-internal"), {}, [
      credit(5_000_000, "cust-internal"),
    ]);
    expect(result.fired).toBe(false);
  });

  it("fires when both legs are internal but excludeInternal is false", () => {
    const result = evaluateRapidInflowOutflow(ctx("4500000", 35, "cust-internal"), { excludeInternal: false }, [
      credit(5_000_000, "cust-internal"),
    ]);
    expect(result.fired).toBe(true);
  });
});
