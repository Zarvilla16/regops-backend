import { CustomerType, TransactionChannel, TransactionType } from "@regops/shared";
import { evaluateVelocitySpike, VelocityRawStats } from "./velocity-spike.evaluator";
import { EvaluationContext } from "../types";

const NOW = new Date("2026-07-01T12:00:00Z");

function ctx(customerAgeDays: number): EvaluationContext {
  return {
    tenantId: "tenant-1",
    now: NOW,
    customer: {
      id: "cust-1",
      fullName: "John Doe",
      customerType: CustomerType.INDIVIDUAL,
      isPep: false,
      isSanctioned: false,
      onboardedAt: new Date(NOW.getTime() - customerAgeDays * 86_400_000),
    },
    transaction: {
      id: "txn-1",
      customerId: "cust-1",
      amount: "0",
      currency: "NGN",
      type: TransactionType.CREDIT,
      channel: TransactionChannel.MOBILE,
      counterpartyAccount: null,
      counterpartyBank: null,
      counterpartyName: null,
      counterpartyCustomerId: null,
      occurredAt: NOW,
    },
  };
}

function stats(overrides: Partial<VelocityRawStats>): VelocityRawStats {
  return {
    rollingDailyAvg: 1_000_000,
    todayTotal: 0,
    todayCount: 1,
    historicalDayCount: 30,
    dormancyDays: 0,
    hasPriorActivityInWindow: true,
    customerAgeDays: 365,
    ...overrides,
  };
}

describe("evaluateVelocitySpike", () => {
  it("fires on 1M/day for 30 days then 7M today (7x spike)", () => {
    const result = evaluateVelocitySpike(ctx(365), {}, stats({ todayTotal: 7_000_000 }));
    expect(result.fired).toBe(true);
  });

  it("does not fire for a backdated transaction processed today, even when today's volume spikes", () => {
    const backdated = ctx(365);
    backdated.transaction.occurredAt = new Date(NOW.getTime() - 3 * 86_400_000);
    const result = evaluateVelocitySpike(backdated, {}, stats({ todayTotal: 7_000_000 }));
    expect(result.fired).toBe(false);
  });

  it("does not fire on 1M/day for 30 days then 3M today (3x < 5x threshold)", () => {
    const result = evaluateVelocitySpike(ctx(365), {}, stats({ todayTotal: 3_000_000 }));
    expect(result.fired).toBe(false);
  });

  it("does not fire on 100K/day baseline then 700K today (7x ratio but below absolute 1M)", () => {
    const result = evaluateVelocitySpike(ctx(365), {}, stats({ rollingDailyAvg: 100_000, todayTotal: 700_000 }));
    expect(result.fired).toBe(false);
  });

  it("does not fire for a customer created 5 days ago (new customer exclusion)", () => {
    const result = evaluateVelocitySpike(ctx(5), {}, stats({ todayTotal: 7_000_000, customerAgeDays: 5 }));
    expect(result.fired).toBe(false);
  });

  it("fires for a customer dormant 90 days returning with 2M today (dormancy reactivation, extreme ratio)", () => {
    const result = evaluateVelocitySpike(
      ctx(365),
      {},
      stats({ rollingDailyAvg: 0, historicalDayCount: 0, dormancyDays: 90, hasPriorActivityInWindow: true, todayTotal: 2_000_000 }),
    );
    expect(result.fired).toBe(true);
    expect(result.evidence?.facts.isDormancyReactivation).toBe(true);
  });

  it("does not fire when history is sparse but dormancy is below the reactivation window", () => {
    const result = evaluateVelocitySpike(
      ctx(365),
      {},
      stats({ rollingDailyAvg: 0, historicalDayCount: 1, dormancyDays: 10, hasPriorActivityInWindow: true, todayTotal: 2_000_000 }),
    );
    expect(result.fired).toBe(false);
  });

  it("does not fire on an established customer's very first-ever transaction (no prior activity at all, not a real reactivation)", () => {
    // dormancyDays falls back to the full window size when there's no prior
    // activity — indistinguishable from a genuinely dormant customer unless
    // hasPriorActivityInWindow is checked first. Regression test for a real
    // bug caught by the e2e suite: a brand-new customer's first transaction
    // was firing VELOCITY_SPIKE.
    const result = evaluateVelocitySpike(
      ctx(365),
      {},
      stats({ rollingDailyAvg: 0, historicalDayCount: 0, dormancyDays: 90, hasPriorActivityInWindow: false, todayTotal: 6_000_000 }),
    );
    expect(result.fired).toBe(false);
  });
});
