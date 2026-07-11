import { ScreeningCheckType, ScreeningProviderName } from "@regops/shared";
import { ProviderMatch, ScreeningInput, ScreeningProvider, ScreeningResult } from "../types";
import { bandHighestScore } from "../thresholds";
import { fetchProviderJson } from "./http-client";

const DEFAULT_TIMEOUT_MS = 10000;

/** Resolved config — apiKey/appId already plaintext-resolved from
 * credentials_ref by SecretsService (Section 7.4); this class never touches
 * a vault/env ref itself. */
export interface PremblyConfig {
  apiKey: string;
  appId: string;
  baseUrl?: string;
  timeoutMs?: number;
}

/** Best-effort shape of https://docs.prembly.com's watchlist/AML screening
 * response — this sandbox has no network access to fetch the live schema;
 * field names follow the spec's own wording. Revisit against the real
 * sandbox response before enabling this provider outside MockProvider-only
 * environments. */
interface PremblyWatchlistResponse {
  reference: string;
  data: {
    watchlist_hits?: {
      source: string;
      matched_name: string;
      score: number;
      [key: string]: unknown;
    }[];
  };
}

export class PremblyProvider implements ScreeningProvider {
  readonly name = ScreeningProviderName.PREMBLY;
  readonly supportedChecks = [ScreeningCheckType.SANCTIONS, ScreeningCheckType.PEP, ScreeningCheckType.ADVERSE_MEDIA];

  async screen(checkType: ScreeningCheckType, input: ScreeningInput, rawConfig: Record<string, unknown>): Promise<ScreeningResult> {
    const config = rawConfig as unknown as PremblyConfig;
    const baseUrl = config.baseUrl ?? "https://api.prembly.com/identitypass/verification";
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const { data, latencyMs } = await fetchProviderJson<PremblyWatchlistResponse>({
      url: `${baseUrl}/aml/watchlist`,
      timeoutMs,
      headers: {
        "x-api-key": config.apiKey,
        "app-id": config.appId,
      },
      body: {
        check_type: checkType,
        full_name: input.fullName,
        date_of_birth: input.dateOfBirth ? new Date(input.dateOfBirth).toISOString().slice(0, 10) : undefined,
        country: input.country ?? undefined,
        nationality: input.nationality ?? undefined,
        gender: input.gender ?? undefined,
      },
    });

    const matches: ProviderMatch[] = (data.data.watchlist_hits ?? []).map((hit) => ({
      listSource: hit.source.toUpperCase().replace(/[^A-Z0-9]+/g, "_"),
      matchName: hit.matched_name,
      matchScore: hit.score,
      matchData: hit as unknown as Record<string, unknown>,
    }));

    const highestMatchScore = matches.reduce((max, m) => Math.max(max, m.matchScore), 0);

    return {
      // Same reasoning as SmileIdProvider — banded against DEFAULT
      // thresholds only as a fallback; the orchestrator always re-bands with
      // the tenant's actual configured thresholds.
      status: bandHighestScore(highestMatchScore),
      highestMatchScore,
      matches,
      providerReference: data.reference,
      rawResponse: data,
      latencyMs,
    };
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: "PremblyProvider health check not implemented — v1 assumes reachable" };
  }
}
