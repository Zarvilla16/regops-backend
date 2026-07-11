import { ScreeningCheckType, ScreeningProviderName, ScreeningResultType } from "@regops/shared";

export interface ScreeningInput {
  fullName: string;
  dateOfBirth?: Date | null;
  bvn?: string | null;
  nin?: string | null;
  /** ISO alpha-2. */
  country?: string | null;
  /** ISO alpha-2. */
  nationality?: string | null;
  gender?: "M" | "F" | null;
}

export interface ProviderMatch {
  listSource: string;
  matchName: string;
  matchScore: number;
  matchData: Record<string, unknown>;
}

export interface ScreeningResult {
  status: ScreeningResultType;
  highestMatchScore: number;
  matches: ProviderMatch[];
  providerReference: string;
  rawResponse: unknown;
  latencyMs: number;
  errorMessage?: string;
}

export interface ScreeningProvider {
  readonly name: ScreeningProviderName;
  readonly supportedChecks: ScreeningCheckType[];

  screen(checkType: ScreeningCheckType, input: ScreeningInput, config: Record<string, unknown>): Promise<ScreeningResult>;

  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}

/** Timeout, 5xx, or network failure — the orchestrator retries, then falls
 * back, on this error class only (Section 4.5/7.1/7.2). */
export class ProviderTransientError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "ProviderTransientError";
  }
}

/** 4xx / bad input — never retried, never falls back, since the same bad
 * input would fail identically against any provider (Section 7.1/7.2). */
export class ProviderBadRequestError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "ProviderBadRequestError";
  }
}
