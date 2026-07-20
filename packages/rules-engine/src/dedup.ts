/**
 * Dedup-key bucket helpers. The spec describes several scenarios' dedup
 * windows as "rolling," anchored to the first qualifying transaction in the
 * window (e.g. structuring's "rolling-24h bucket starting at the first
 * qualifying transaction"). That needs state (when did the window start?)
 * that a stateless, per-transaction evaluation doesn't have without an extra
 * DB round trip. Every evaluator here instead uses simple, deterministic
 * calendar/interval bucketing — a UTC day for 24h-scale dedup, a fixed
 * N-minute interval index for sub-day dedup — which is idempotent (the same
 * transaction always maps to the same bucket, replay-safe) at the cost of a
 * pattern that spans a bucket boundary (e.g. just before/after UTC midnight)
 * producing two Alerts instead of one. Documented, accepted simplification —
 * see HANDOFF.md's Prompt 5 deviations.
 */
export function dayBucket(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function intervalBucket(date: Date, minutes: number): string {
  const ms = Math.max(1, minutes) * 60_000;
  return String(Math.floor(date.getTime() / ms));
}
