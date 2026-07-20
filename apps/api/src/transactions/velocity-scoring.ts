/**
 * Pure velocity sub-signal scoring (spec Section 9.2) — deliberately has no
 * DB/QueryRunner dependency so it's unit-testable in isolation; VelocityAdapterService
 * (this directory) is the only caller, and owns the SQL query that produces
 * `DailyStat[]`.
 *
 * The spec gives point RANGES ("0-25", "0-10", "0-15") but no graduated
 * formula for scaling within them — each sub-signal is implemented as a flat
 * award on detection (25 / 10 / 15) rather than an invented sliding scale,
 * since that's the only fully-specified reading of the spec text.
 */
export interface DailyStat {
  /** YYYY-MM-DD, UTC. */
  day: string;
  total: number;
  count: number;
  channels: string[];
}

export interface VelocityFactorConfig {
  spikeMultiplier?: number;
  spikeMinAmount?: number;
  dormancyDays?: number;
  maxScore?: number;
}

const SPIKE_AWARD = 25;
const CHANNEL_ANOMALY_AWARD = 10;
const DORMANCY_REACTIVATION_AWARD = 15;
const REACTIVATION_WINDOW_DAYS = 7;

function daysBefore(now: Date, days: number): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export function computeVelocityScore(
  rows: DailyStat[],
  config: VelocityFactorConfig,
  now: Date,
): { score: number; detail: Record<string, unknown> } {
  const spikeMultiplier = config.spikeMultiplier ?? 5;
  const spikeMinAmount = config.spikeMinAmount ?? 1_000_000;
  const dormancyDays = config.dormancyDays ?? 90;
  const maxScore = config.maxScore ?? 50;

  const today = now.toISOString().slice(0, 10);
  const reactivationStart = daysBefore(now, REACTIVATION_WINDOW_DAYS - 1);
  const last30Start = daysBefore(now, 29);

  const todayRow = rows.find((r) => r.day === today) ?? null;
  // "Rolling 30-day average" excludes today itself — averaging a spike day
  // into its own baseline would dilute the very signal being measured.
  const historicalRows = rows.filter((r) => r.day >= last30Start && r.day < today);

  const todayTotal = todayRow?.total ?? 0;
  const rollingAvg =
    historicalRows.length > 0 ? historicalRows.reduce((sum, r) => sum + r.total, 0) / historicalRows.length : 0;
  const spikeDetected = todayTotal > 0 && todayTotal > spikeMultiplier * rollingAvg && todayTotal > spikeMinAmount;

  const historicalChannels = new Set(historicalRows.flatMap((r) => r.channels));
  const todayChannels = todayRow?.channels ?? [];
  const channelAnomaly = historicalChannels.size > 0 && todayChannels.some((c) => !historicalChannels.has(c));

  const priorWindowRows = rows.filter((r) => r.day >= daysBefore(now, dormancyDays) && r.day < reactivationStart);
  const recentRows = rows.filter((r) => r.day >= reactivationStart && r.day <= today);
  const dormancyReactivation = priorWindowRows.length === 0 && recentRows.length > 0;

  const spikeScore = spikeDetected ? SPIKE_AWARD : 0;
  const channelScore = channelAnomaly ? CHANNEL_ANOMALY_AWARD : 0;
  const dormancyScore = dormancyReactivation ? DORMANCY_REACTIVATION_AWARD : 0;
  const score = Math.min(spikeScore + channelScore + dormancyScore, maxScore);

  return {
    score,
    detail: {
      todayTotal,
      rollingAvg,
      spikeDetected,
      spikeScore,
      channelAnomaly,
      channelScore,
      newChannelsToday: todayChannels.filter((c) => !historicalChannels.has(c)),
      dormancyReactivation,
      dormancyScore,
      historicalDayCount: historicalRows.length,
      todayTransactionCount: todayRow?.count ?? 0,
    },
  };
}
