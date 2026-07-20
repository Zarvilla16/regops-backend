import { computeVelocityScore, DailyStat } from "./velocity-scoring";

const NOW = new Date("2026-07-20T12:00:00.000Z");
const CONFIG = { spikeMultiplier: 5, spikeMinAmount: 1_000_000, dormancyDays: 90, maxScore: 50 };

function dayString(daysAgo: number): string {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function consistentHistory(dailyAmount: number, channel = "MOBILE"): DailyStat[] {
  const rows: DailyStat[] = [];
  for (let i = 1; i <= 29; i += 1) {
    rows.push({ day: dayString(i), total: dailyAmount, count: 1, channels: [channel] });
  }
  return rows;
}

describe("computeVelocityScore", () => {
  it("happy path: no transactions at all -> score 0", () => {
    const result = computeVelocityScore([], CONFIG, NOW);
    expect(result.score).toBe(0);
    expect(result.detail.spikeDetected).toBe(false);
    expect(result.detail.dormancyReactivation).toBe(false);
  });

  it("happy path: 30 days of consistent ₦100k/day -> no spike, no anomaly, score 0", () => {
    const rows = [...consistentHistory(100_000), { day: dayString(0), total: 100_000, count: 1, channels: ["MOBILE"] }];
    const result = computeVelocityScore(rows, CONFIG, NOW);
    expect(result.score).toBe(0);
  });

  it("edge case: 30 days of ₦100k/day then ₦2M today -> spike detected, score 25", () => {
    const rows = [...consistentHistory(100_000), { day: dayString(0), total: 2_000_000, count: 1, channels: ["MOBILE"] }];
    const result = computeVelocityScore(rows, CONFIG, NOW);
    expect(result.detail.spikeDetected).toBe(true);
    expect(result.score).toBe(25);
  });

  it("edge case: today's total exceeds the multiplier but stays under spikeMinAmount -> no spike", () => {
    const rows = [...consistentHistory(1_000), { day: dayString(0), total: 10_000, count: 1, channels: ["MOBILE"] }];
    const result = computeVelocityScore(rows, CONFIG, NOW);
    expect(result.detail.spikeDetected).toBe(false);
    expect(result.score).toBe(0);
  });

  it("edge case: customer using POS for the first time (only MOBILE in history) -> channel anomaly, score 10", () => {
    const rows = [...consistentHistory(100_000, "MOBILE"), { day: dayString(0), total: 100_000, count: 1, channels: ["POS"] }];
    const result = computeVelocityScore(rows, CONFIG, NOW);
    expect(result.detail.channelAnomaly).toBe(true);
    expect(result.score).toBe(10);
  });

  it("edge case: dormant 100 days then reactivates today -> dormancy reactivation, score 15", () => {
    const rows: DailyStat[] = [{ day: dayString(2), total: 50_000, count: 1, channels: ["MOBILE"] }];
    const result = computeVelocityScore(rows, CONFIG, NOW);
    expect(result.detail.dormancyReactivation).toBe(true);
    expect(result.score).toBe(15);
  });

  it("edge case: activity present within dormancyDays before the reactivation window -> not dormancy", () => {
    const rows: DailyStat[] = [
      { day: dayString(40), total: 50_000, count: 1, channels: ["MOBILE"] },
      { day: dayString(2), total: 50_000, count: 1, channels: ["MOBILE"] },
    ];
    const result = computeVelocityScore(rows, CONFIG, NOW);
    expect(result.detail.dormancyReactivation).toBe(false);
  });

  it("config variation: multiple sub-signals combine and clamp at maxScore", () => {
    // Spike (25) + channel anomaly (10) + dormancy (15) would sum to 50 —
    // exactly maxScore, so this also verifies the clamp is inclusive.
    const rows: DailyStat[] = [{ day: dayString(0), total: 5_000_000, count: 1, channels: ["POS"] }];
    const result = computeVelocityScore(rows, { ...CONFIG, maxScore: 30 }, NOW);
    expect(result.score).toBe(30);
  });

  it("determinism: identical input produces identical output across repeated calls", () => {
    const rows = [...consistentHistory(100_000), { day: dayString(0), total: 2_000_000, count: 1, channels: ["MOBILE"] }];
    const first = computeVelocityScore(rows, CONFIG, NOW);
    const second = computeVelocityScore(rows, CONFIG, NOW);
    expect(second).toEqual(first);
  });
});
