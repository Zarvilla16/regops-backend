import { CustomerType, RuleScenarioType, TransactionChannel, TransactionType } from "@regops/shared";
import { dispatchEvaluation } from "./dispatch";
import { EvaluationContext } from "./types";

const NOW = new Date("2026-07-01T12:00:00Z");

function ctx(overrides: Partial<EvaluationContext["transaction"]> = {}): EvaluationContext {
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
      amount: "6000000",
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

describe("dispatchEvaluation", () => {
  it("dispatches LARGE_CASH", () => {
    const result = dispatchEvaluation(ctx(), {}, { scenarioType: RuleScenarioType.LARGE_CASH });
    expect(result.fired).toBe(true);
  });

  it("dispatches STRUCTURING", () => {
    const result = dispatchEvaluation(ctx({ amount: "2000000" }), {}, {
      scenarioType: RuleScenarioType.STRUCTURING,
      recentCashTxns: [],
    });
    expect(result.fired).toBe(false);
  });

  it("dispatches RAPID_INFLOW_OUTFLOW", () => {
    const result = dispatchEvaluation(ctx({ type: TransactionType.DEBIT, channel: TransactionChannel.TRANSFER }), {}, {
      scenarioType: RuleScenarioType.RAPID_INFLOW_OUTFLOW,
      recentCredits: [],
    });
    expect(result.fired).toBe(false);
  });

  it("dispatches HIGH_RISK_COUNTERPARTY", () => {
    const result = dispatchEvaluation(ctx(), {}, {
      scenarioType: RuleScenarioType.HIGH_RISK_COUNTERPARTY,
      screening: null,
    });
    expect(result.fired).toBe(false);
  });

  it("dispatches VELOCITY_SPIKE", () => {
    const result = dispatchEvaluation(ctx(), {}, {
      scenarioType: RuleScenarioType.VELOCITY_SPIKE,
      stats: {
        rollingDailyAvg: 0,
        todayTotal: 0,
        todayCount: 0,
        historicalDayCount: 0,
        dormancyDays: 0,
        hasPriorActivityInWindow: false,
        customerAgeDays: 5,
      },
    });
    expect(result.fired).toBe(false);
  });
});
