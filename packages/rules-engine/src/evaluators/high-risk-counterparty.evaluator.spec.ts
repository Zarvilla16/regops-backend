import { AlertSeverity, CustomerType, TransactionChannel, TransactionType } from "@regops/shared";
import { evaluateHighRiskCounterparty } from "./high-risk-counterparty.evaluator";
import { EvaluationContext } from "../types";

const NOW = new Date("2026-07-01T12:00:00Z");

function ctx(amount = "2500000"): EvaluationContext {
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
      id: "txn-1",
      customerId: "cust-1",
      amount,
      currency: "NGN",
      type: TransactionType.DEBIT,
      channel: TransactionChannel.TRANSFER,
      counterpartyAccount: "0123456789",
      counterpartyBank: "058",
      counterpartyName: "IBRAHIM SANCTIONED DOE",
      counterpartyCustomerId: null,
      occurredAt: NOW,
    },
  };
}

describe("evaluateHighRiskCounterparty", () => {
  it("fires CRITICAL for an external counterparty confirmed sanctioned", () => {
    const result = evaluateHighRiskCounterparty(ctx(), {}, {
      isInternal: false,
      isSanctioned: true,
      isPep: false,
      matchSource: "OFAC_SDN",
      matchScore: 94,
      screeningCheckId: "check-1",
    });
    expect(result.fired).toBe(true);
    expect(result.severity).toBe(AlertSeverity.CRITICAL);
  });

  it("fires MEDIUM for an external counterparty matching PEP only", () => {
    const result = evaluateHighRiskCounterparty(ctx(), {}, {
      isInternal: false,
      isSanctioned: false,
      isPep: true,
      matchSource: "PEP_DB",
      matchScore: 88,
      screeningCheckId: "check-2",
    });
    expect(result.fired).toBe(true);
    expect(result.severity).toBe(AlertSeverity.MEDIUM);
  });

  it("does not fire for a clean external counterparty", () => {
    const result = evaluateHighRiskCounterparty(ctx(), {}, {
      isInternal: false,
      isSanctioned: false,
      isPep: false,
      matchSource: null,
      matchScore: null,
      screeningCheckId: "check-3",
    });
    expect(result.fired).toBe(false);
  });

  it("fires CRITICAL for an internal counterparty already flagged sanctioned, without external screening", () => {
    const result = evaluateHighRiskCounterparty(ctx(), {}, {
      isInternal: true,
      isSanctioned: true,
      isPep: false,
      matchSource: null,
      matchScore: null,
      screeningCheckId: null,
    });
    expect(result.fired).toBe(true);
    expect(result.severity).toBe(AlertSeverity.CRITICAL);
    expect(result.evidence?.facts.isInternalCounterparty).toBe(true);
  });

  it("fires MEDIUM for an internal counterparty flagged PEP but not sanctioned", () => {
    const result = evaluateHighRiskCounterparty(ctx(), {}, {
      isInternal: true,
      isSanctioned: false,
      isPep: true,
      matchSource: null,
      matchScore: null,
      screeningCheckId: null,
    });
    expect(result.fired).toBe(true);
    expect(result.severity).toBe(AlertSeverity.MEDIUM);
  });

  it("does not fire below skipBelowAmount even for a sanctioned counterparty", () => {
    const result = evaluateHighRiskCounterparty(ctx("5000"), {}, {
      isInternal: false,
      isSanctioned: true,
      isPep: false,
      matchSource: "OFAC_SDN",
      matchScore: 99,
      screeningCheckId: "check-4",
    });
    expect(result.fired).toBe(false);
  });

  it("does not fire when there is no counterparty to screen at all", () => {
    const result = evaluateHighRiskCounterparty(ctx(), {}, null);
    expect(result.fired).toBe(false);
  });
});
