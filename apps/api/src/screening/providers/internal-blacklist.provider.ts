import { Injectable } from "@nestjs/common";
import { QueryRunner } from "typeorm";
import { InternalBlacklistEntity } from "@regops/db";
import { ScreeningResultType } from "@regops/shared";
import { ScreeningInput, ScreeningResult } from "@regops/screening-engine";

const FUZZY_NAME_SIMILARITY_THRESHOLD = 0.85;

/**
 * Hard-wired into the orchestrator, always runs before external providers,
 * short-circuits (skips the external provider call entirely) on a match
 * (Section 4.4). Needs tenant-scoped DB access via the request's own
 * QueryRunner, which the shared ScreeningProvider interface (Section 4.2)
 * doesn't carry a parameter for — this deliberately does NOT implement that
 * interface (it's resolved directly by name in ScreeningService, never
 * through ProviderRegistry.resolve()'s interchangeable primary/fallback
 * mechanism external providers use), so its `check()` method takes a
 * QueryRunner explicitly instead.
 */
@Injectable()
export class InternalBlacklistProvider {
  /** Returns null when there's no match — the caller (ScreeningService)
   * proceeds to the external provider in that case. A match always returns
   * CONFIRMED_MATCH at score 100, list_source INTERNAL_BLACKLIST (Section 4.4). */
  async check(queryRunner: QueryRunner, tenantId: string, input: ScreeningInput): Promise<ScreeningResult | null> {
    const start = Date.now();
    const qb = queryRunner.manager
      .getRepository(InternalBlacklistEntity)
      .createQueryBuilder("bl")
      .where("bl.tenant_id = :tenantId", { tenantId })
      .andWhere("(bl.expires_at IS NULL OR bl.expires_at > now())");

    const orConditions: string[] = [];
    const params: Record<string, unknown> = { tenantId };

    if (input.bvn) {
      orConditions.push("bl.bvn = :bvn");
      params.bvn = input.bvn;
    }
    if (input.nin) {
      orConditions.push("bl.nin = :nin");
      params.nin = input.nin;
    }
    orConditions.push("similarity(bl.full_name, :fullName) >= :threshold");
    params.fullName = input.fullName;
    params.threshold = FUZZY_NAME_SIMILARITY_THRESHOLD;

    qb.andWhere(`(${orConditions.join(" OR ")})`, params);
    qb.orderBy("similarity(bl.full_name, :fullName)", "DESC");

    const hit = await qb.getOne();
    if (!hit) return null;

    return {
      status: ScreeningResultType.CONFIRMED_MATCH,
      highestMatchScore: 100,
      matches: [
        {
          listSource: "INTERNAL_BLACKLIST",
          matchName: hit.fullName,
          matchScore: 100,
          matchData: { blacklistId: hit.id, reason: hit.reason, bvn: hit.bvn, nin: hit.nin },
        },
      ],
      providerReference: hit.id,
      rawResponse: { blacklistId: hit.id },
      latencyMs: Date.now() - start,
    };
  }
}
