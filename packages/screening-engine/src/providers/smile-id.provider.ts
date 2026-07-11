import { createHmac } from "crypto";
import { ScreeningCheckType, ScreeningProviderName } from "@regops/shared";
import { ProviderMatch, ScreeningInput, ScreeningProvider, ScreeningResult } from "../types";
import { bandHighestScore } from "../thresholds";
import { fetchProviderJson } from "./http-client";

const DEFAULT_TIMEOUT_MS = 8000;

/** Resolved config for a SmileIdProvider call — apiKey/apiSecret are the
 * plaintext values already resolved from credentials_ref by SecretsService;
 * this class never touches a vault/env ref itself (Section 7.4). */
export interface SmileIdConfig {
  apiKey: string;
  apiSecret: string;
  baseUrl?: string;
  timeoutMs?: number;
}

/** Best-effort shape of https://docs.usesmileid.com's AML check response —
 * this sandbox has no network access to fetch the live schema, so field
 * names follow the spec's own wording (match_categories, confidence_value)
 * as closely as possible. Revisit against the real sandbox response before
 * enabling this provider outside MockProvider-only environments. */
interface SmileIdAmlResponse {
  job_id: string;
  result: {
    matches?: {
      list_category: string;
      full_name: string;
      confidence_value: number;
      [key: string]: unknown;
    }[];
  };
}

function mapListSource(smileIdCategory: string): string {
  // Section 7.1: "Map their match_categories to RegOps list_sources (e.g.
  // 'OFAC_SDN' -> 'OFAC_SDN', 'UN_CONSOLIDATED' -> 'UN_CONSOLIDATED')" — the
  // example is an identity mapping, so pass through uppercased/underscored
  // unless a specific Smile ID category needs renaming.
  return smileIdCategory.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

export class SmileIdProvider implements ScreeningProvider {
  readonly name = ScreeningProviderName.SMILE_ID;
  readonly supportedChecks = [ScreeningCheckType.SANCTIONS, ScreeningCheckType.PEP, ScreeningCheckType.ADVERSE_MEDIA];

  async screen(checkType: ScreeningCheckType, input: ScreeningInput, rawConfig: Record<string, unknown>): Promise<ScreeningResult> {
    const config = rawConfig as unknown as SmileIdConfig;
    const baseUrl = config.baseUrl ?? "https://api.smileidentity.com/v1";
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const timestamp = new Date().toISOString();
    // Signature-based auth per Section 7.1: HMAC-SHA256 over timestamp +
    // apiKey, matching the general "signature = hmac(secret, timestamp +
    // partner_id)" shape Smile ID's other APIs document publicly. Exact
    // field names should be re-verified against usesmileid.com's AML
    // endpoint docs before this leaves MockProvider-only environments.
    const signature = createHmac("sha256", config.apiSecret).update(`${timestamp}${config.apiKey}`).digest("base64");

    const { data, latencyMs } = await fetchProviderJson<SmileIdAmlResponse>({
      url: `${baseUrl}/aml/check`,
      timeoutMs,
      headers: {
        "smileid-partner-id": config.apiKey,
        "smileid-signature": signature,
        "smileid-timestamp": timestamp,
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

    const matches: ProviderMatch[] = (data.result.matches ?? []).map((m) => ({
      listSource: mapListSource(m.list_category),
      matchName: m.full_name,
      matchScore: m.confidence_value,
      matchData: m as unknown as Record<string, unknown>,
    }));

    const highestMatchScore = matches.reduce((max, m) => Math.max(max, m.matchScore), 0);

    return {
      // Banded against the DEFAULT thresholds here as a sane fallback value —
      // providers have no visibility into a tenant's configured overrides
      // (Section 4.3). The orchestrator (apps/api's ScreeningService) always
      // re-bands with the tenant's actual thresholds before persisting or
      // deciding anything, so this value is never load-bearing on its own.
      status: bandHighestScore(highestMatchScore),
      highestMatchScore,
      matches,
      providerReference: data.job_id,
      rawResponse: data,
      latencyMs,
    };
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: "SmileIdProvider health check not implemented — v1 assumes reachable" };
  }
}
