import { ScreeningCheckType, ScreeningProviderName } from "@regops/shared";
import { ProviderBadRequestError, ScreeningInput, ScreeningProvider, ScreeningResult } from "./types";

export interface ProviderCallTarget {
  provider: ScreeningProvider;
  config: Record<string, unknown>;
}

export interface FallbackResult {
  result: ScreeningResult;
  providerUsed: ScreeningProviderName;
  attempts: number;
}

export interface FallbackOptions {
  /**
   * One entry per retry (not counting the initial attempt), in order.
   * Section 4.5: "Retry primary once with exponential backoff (1s, then
   * 4s)" — read as up to two retries (three total primary attempts) at
   * those two delays; defaults to that literal schedule. Tests override this
   * with near-zero delays so retry/fallback paths don't actually sleep for
   * seconds.
   */
  retryDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_RETRY_DELAYS_MS = [1000, 4000];

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Section 4.5's fallback/retry logic, provider-agnostic (works for any
 * ScreeningProvider, real or Mock):
 *   1. Retry the primary provider per `retryDelaysMs`'s schedule.
 *   2. If primary is still failing and a fallback is configured, try the
 *      fallback exactly once (no further retries on the fallback itself).
 *   3. If both are exhausted, rethrow the last error — the caller (Section
 *      5.1's sync sanctions path, or the async worker) decides what a
 *      terminal failure means for its own flow (503 fail-closed vs. a
 *      retry-after-1-hour job schedule).
 * A ProviderBadRequestError (bad input) is never retried and never falls
 * back — the same bad input would fail identically against any provider.
 */
export async function screenWithFallback(
  checkType: ScreeningCheckType,
  input: ScreeningInput,
  primary: ProviderCallTarget,
  fallback: ProviderCallTarget | undefined,
  options: FallbackOptions = {},
): Promise<FallbackResult> {
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  let attempts = 0;

  for (let attemptIndex = 0; attemptIndex <= retryDelaysMs.length; attemptIndex += 1) {
    attempts += 1;
    try {
      const result = await primary.provider.screen(checkType, input, primary.config);
      return { result, providerUsed: primary.provider.name, attempts };
    } catch (err) {
      if (err instanceof ProviderBadRequestError) throw err;
      lastError = err;
      if (attemptIndex < retryDelaysMs.length) {
        await sleep(retryDelaysMs[attemptIndex]);
      }
    }
  }

  if (fallback) {
    attempts += 1;
    try {
      const result = await fallback.provider.screen(checkType, input, fallback.config);
      return { result, providerUsed: fallback.provider.name, attempts };
    } catch (err) {
      if (err instanceof ProviderBadRequestError) throw err;
      lastError = err;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Screening provider call failed");
}
