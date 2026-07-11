import { ScreeningCheckType, ScreeningProviderName, ScreeningResultType } from "@regops/shared";
import { screenWithFallback } from "./fallback";
import { ProviderBadRequestError, ProviderTransientError, ScreeningProvider, ScreeningResult } from "./types";

function cleanResult(): ScreeningResult {
  return { status: ScreeningResultType.CLEAN, highestMatchScore: 0, matches: [], providerReference: "ref", rawResponse: {}, latencyMs: 1 };
}

function fakeProvider(name: ScreeningProviderName, screen: ScreeningProvider["screen"]): ScreeningProvider {
  return {
    name,
    supportedChecks: [ScreeningCheckType.SANCTIONS],
    screen,
    healthCheck: async () => ({ ok: true }),
  };
}

// No real delay in tests — the schedule's *shape* (how many attempts happen
// before falling back) is what's under test, not wall-clock timing.
const FAST_OPTIONS = { retryDelaysMs: [1, 1], sleep: async () => undefined };

describe("screenWithFallback", () => {
  it("returns the primary's result on first success, never calling fallback", async () => {
    const primaryScreen = jest.fn().mockResolvedValue(cleanResult());
    const fallbackScreen = jest.fn().mockResolvedValue(cleanResult());
    const primary = { provider: fakeProvider(ScreeningProviderName.SMILE_ID, primaryScreen), config: {} };
    const fallback = { provider: fakeProvider(ScreeningProviderName.PREMBLY, fallbackScreen), config: {} };

    const outcome = await screenWithFallback(ScreeningCheckType.SANCTIONS, { fullName: "Test" }, primary, fallback, FAST_OPTIONS);

    expect(outcome.providerUsed).toBe(ScreeningProviderName.SMILE_ID);
    expect(outcome.attempts).toBe(1);
    expect(primaryScreen).toHaveBeenCalledTimes(1);
    expect(fallbackScreen).not.toHaveBeenCalled();
  });

  it("retries the primary per the configured schedule before falling back", async () => {
    const primaryScreen = jest.fn().mockRejectedValue(new ProviderTransientError("down"));
    const fallbackScreen = jest.fn().mockResolvedValue(cleanResult());
    const primary = { provider: fakeProvider(ScreeningProviderName.SMILE_ID, primaryScreen), config: {} };
    const fallback = { provider: fakeProvider(ScreeningProviderName.PREMBLY, fallbackScreen), config: {} };

    const outcome = await screenWithFallback(ScreeningCheckType.SANCTIONS, { fullName: "Test" }, primary, fallback, FAST_OPTIONS);

    // FAST_OPTIONS configures 2 retry delays => 3 total primary attempts before fallback (Section 4.5).
    expect(primaryScreen).toHaveBeenCalledTimes(3);
    expect(fallbackScreen).toHaveBeenCalledTimes(1);
    expect(outcome.providerUsed).toBe(ScreeningProviderName.PREMBLY);
    expect(outcome.attempts).toBe(4);
  });

  it("falls back after exactly one retry when only one retry delay is configured", async () => {
    const primaryScreen = jest.fn().mockRejectedValue(new ProviderTransientError("down"));
    const fallbackScreen = jest.fn().mockResolvedValue(cleanResult());
    const primary = { provider: fakeProvider(ScreeningProviderName.SMILE_ID, primaryScreen), config: {} };
    const fallback = { provider: fakeProvider(ScreeningProviderName.PREMBLY, fallbackScreen), config: {} };

    await screenWithFallback(ScreeningCheckType.SANCTIONS, { fullName: "Test" }, primary, fallback, {
      retryDelaysMs: [1],
      sleep: async () => undefined,
    });

    expect(primaryScreen).toHaveBeenCalledTimes(2);
    expect(fallbackScreen).toHaveBeenCalledTimes(1);
  });

  it("throws when both primary and fallback are exhausted", async () => {
    const primaryScreen = jest.fn().mockRejectedValue(new ProviderTransientError("primary down"));
    const fallbackScreen = jest.fn().mockRejectedValue(new ProviderTransientError("fallback down"));
    const primary = { provider: fakeProvider(ScreeningProviderName.SMILE_ID, primaryScreen), config: {} };
    const fallback = { provider: fakeProvider(ScreeningProviderName.PREMBLY, fallbackScreen), config: {} };

    await expect(
      screenWithFallback(ScreeningCheckType.SANCTIONS, { fullName: "Test" }, primary, fallback, FAST_OPTIONS),
    ).rejects.toThrow(/fallback down/);
  });

  it("throws without ever calling fallback when no fallback is configured", async () => {
    const primaryScreen = jest.fn().mockRejectedValue(new ProviderTransientError("down"));
    const primary = { provider: fakeProvider(ScreeningProviderName.SMILE_ID, primaryScreen), config: {} };

    await expect(
      screenWithFallback(ScreeningCheckType.SANCTIONS, { fullName: "Test" }, primary, undefined, FAST_OPTIONS),
    ).rejects.toThrow(/down/);
    expect(primaryScreen).toHaveBeenCalledTimes(3);
  });

  it("never retries or falls back on a ProviderBadRequestError", async () => {
    const primaryScreen = jest.fn().mockRejectedValue(new ProviderBadRequestError("bad input"));
    const fallbackScreen = jest.fn().mockResolvedValue(cleanResult());
    const primary = { provider: fakeProvider(ScreeningProviderName.SMILE_ID, primaryScreen), config: {} };
    const fallback = { provider: fakeProvider(ScreeningProviderName.PREMBLY, fallbackScreen), config: {} };

    await expect(
      screenWithFallback(ScreeningCheckType.SANCTIONS, { fullName: "Test" }, primary, fallback, FAST_OPTIONS),
    ).rejects.toBeInstanceOf(ProviderBadRequestError);

    expect(primaryScreen).toHaveBeenCalledTimes(1);
    expect(fallbackScreen).not.toHaveBeenCalled();
  });

  it("never retries a fallback's own ProviderBadRequestError", async () => {
    const primaryScreen = jest.fn().mockRejectedValue(new ProviderTransientError("down"));
    const fallbackScreen = jest.fn().mockRejectedValue(new ProviderBadRequestError("fallback bad input"));
    const primary = { provider: fakeProvider(ScreeningProviderName.SMILE_ID, primaryScreen), config: {} };
    const fallback = { provider: fakeProvider(ScreeningProviderName.PREMBLY, fallbackScreen), config: {} };

    await expect(
      screenWithFallback(ScreeningCheckType.SANCTIONS, { fullName: "Test" }, primary, fallback, FAST_OPTIONS),
    ).rejects.toBeInstanceOf(ProviderBadRequestError);
    expect(fallbackScreen).toHaveBeenCalledTimes(1);
  });
});
