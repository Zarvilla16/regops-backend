import { Injectable } from "@nestjs/common";
import { QueryRunner } from "typeorm";
import { ScreeningProviderConfigEntity } from "@regops/db";
import { ScreeningCheckType, ScreeningProviderConfigDto, ScreeningProviderName } from "@regops/shared";
import { ConfigureProviderEntryDto } from "../dto/configure-providers.dto";

@Injectable()
export class ScreeningProviderConfigService {
  toDto(entity: ScreeningProviderConfigEntity): ScreeningProviderConfigDto {
    return {
      id: entity.id,
      tenantId: entity.tenantId,
      provider: entity.provider,
      checkType: entity.checkType,
      isPrimary: entity.isPrimary,
      isFallback: entity.isFallback,
      isActive: entity.isActive,
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
    };
  }

  async findAllForTenant(queryRunner: QueryRunner, tenantId: string): Promise<ScreeningProviderConfigEntity[]> {
    return queryRunner.manager.getRepository(ScreeningProviderConfigEntity).find({ where: { tenantId } });
  }

  /** Active primary/fallback configs for one (tenant, checkType) — what
   * ProviderRegistry.resolve() reads (Section 4.4). */
  async findActive(
    queryRunner: QueryRunner,
    tenantId: string,
    checkType: ScreeningCheckType,
  ): Promise<ScreeningProviderConfigEntity[]> {
    return queryRunner.manager
      .getRepository(ScreeningProviderConfigEntity)
      .find({ where: { tenantId, checkType, isActive: true } });
  }

  /**
   * Idempotent — safe to call more than once for the same tenant, same
   * spirit as RiskFactorConfigService.seedDefaultsForTenant. Section 11's
   * Definition of Done: "MockProvider as primary in non-prod env; SmileId
   * primary + Prembly fallback in prod env." credentials_ref uses the
   * env:// scheme (Section 7.4) even for MOCK, which never actually reads
   * it — kept non-empty so the NOT NULL column and "never plaintext" habit
   * hold uniformly across every row, real or mock.
   */
  async seedDefaultsForTenant(queryRunner: QueryRunner, tenantId: string, isProd: boolean): Promise<void> {
    const repo = queryRunner.manager.getRepository(ScreeningProviderConfigEntity);
    const checkTypes = [ScreeningCheckType.SANCTIONS, ScreeningCheckType.PEP, ScreeningCheckType.ADVERSE_MEDIA];

    for (const checkType of checkTypes) {
      const existingPrimary = await repo.findOne({ where: { tenantId, checkType, isPrimary: true } });
      if (existingPrimary) continue;

      if (!isProd) {
        await repo.save(
          repo.create({
            tenantId,
            checkType,
            provider: ScreeningProviderName.MOCK,
            isPrimary: true,
            isFallback: false,
            credentialsRef: "env://MOCK_PROVIDER_UNUSED",
            config: {},
            isActive: true,
          }),
        );
        continue;
      }

      // Prod default: Section 7.2's "Prembly primary for PEP, Smile ID
      // fallback; Smile ID primary for sanctions, Prembly fallback" split —
      // ADVERSE_MEDIA follows the sanctions convention (Smile ID primary)
      // since the spec doesn't call out a different default for it.
      const primaryProvider = checkType === ScreeningCheckType.PEP ? ScreeningProviderName.PREMBLY : ScreeningProviderName.SMILE_ID;
      const fallbackProvider = checkType === ScreeningCheckType.PEP ? ScreeningProviderName.SMILE_ID : ScreeningProviderName.PREMBLY;

      await repo.save(
        repo.create({
          tenantId,
          checkType,
          provider: primaryProvider,
          isPrimary: true,
          isFallback: false,
          credentialsRef: `env://${primaryProvider}_API_KEY_TENANT_${tenantId}`,
          config: {},
          isActive: true,
        }),
      );
      await repo.save(
        repo.create({
          tenantId,
          checkType,
          provider: fallbackProvider,
          isPrimary: false,
          isFallback: true,
          credentialsRef: `env://${fallbackProvider}_API_KEY_TENANT_${tenantId}`,
          config: {},
          isActive: true,
        }),
      );
    }
  }

  /** PUT /screening/providers — replaces the tenant's full config set in one
   * call. Deletes existing rows and re-inserts, inside the caller's
   * transaction, so a partial write can never leave a tenant with an
   * inconsistent mix of old and new provider configs. */
  async replaceForTenant(
    queryRunner: QueryRunner,
    tenantId: string,
    entries: ConfigureProviderEntryDto[],
  ): Promise<ScreeningProviderConfigEntity[]> {
    const repo = queryRunner.manager.getRepository(ScreeningProviderConfigEntity);
    await repo.delete({ tenantId });

    const saved: ScreeningProviderConfigEntity[] = [];
    for (const entry of entries) {
      saved.push(
        await repo.save(
          repo.create({
            tenantId,
            checkType: entry.checkType,
            provider: entry.provider,
            isPrimary: entry.isPrimary,
            isFallback: entry.isFallback,
            credentialsRef: entry.credentialsRef,
            config: entry.config ?? {},
            isActive: true,
          }),
        ),
      );
    }
    return saved;
  }
}
