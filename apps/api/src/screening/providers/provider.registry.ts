import { Injectable, InternalServerErrorException } from "@nestjs/common";
import { QueryRunner } from "typeorm";
import { ScreeningProviderConfigEntity } from "@regops/db";
import { ScreeningCheckType, ScreeningProviderName } from "@regops/shared";
import { MockProvider, PremblyProvider, ScreeningProvider, SmileIdProvider } from "@regops/screening-engine";
import { SecretsService } from "../secrets.service";
import { ScreeningProviderConfigService } from "./screening-provider-config.service";

export interface ResolvedProvider {
  provider: ScreeningProvider;
  config: Record<string, unknown>;
}

@Injectable()
export class ProviderRegistry {
  constructor(
    private readonly smileId: SmileIdProvider,
    private readonly prembly: PremblyProvider,
    private readonly mock: MockProvider,
    private readonly configService: ScreeningProviderConfigService,
    private readonly secretsService: SecretsService,
  ) {}

  private byName(name: ScreeningProviderName): ScreeningProvider {
    switch (name) {
      case ScreeningProviderName.SMILE_ID:
        return this.smileId;
      case ScreeningProviderName.PREMBLY:
        return this.prembly;
      case ScreeningProviderName.MOCK:
        return this.mock;
    }
  }

  /** Merges the config row's resolved secret into its jsonb `config` blob
   * under a fixed `apiKey`/`apiSecret`/`appId`-shaped convention each real
   * provider's Config interface expects — MockProvider ignores all of it. */
  private async toResolvedProvider(entity: ScreeningProviderConfigEntity): Promise<ResolvedProvider> {
    const provider = this.byName(entity.provider);
    const secret = await this.secretsService.resolve(entity.credentialsRef);

    const config: Record<string, unknown> =
      entity.provider === ScreeningProviderName.PREMBLY
        ? { apiKey: secret, appId: (entity.config.appId as string) ?? "", ...entity.config }
        : { apiKey: secret, apiSecret: (entity.config.apiSecret as string) ?? secret, ...entity.config };

    return { provider, config };
  }

  async resolve(
    queryRunner: QueryRunner,
    tenantId: string,
    checkType: ScreeningCheckType,
  ): Promise<{ primary: ResolvedProvider; fallback?: ResolvedProvider }> {
    const configs = await this.configService.findActive(queryRunner, tenantId, checkType);
    const primaryConfig = configs.find((c) => c.isPrimary);
    const fallbackConfig = configs.find((c) => c.isFallback);

    if (!primaryConfig) {
      throw new InternalServerErrorException({
        code: "NO_PRIMARY_PROVIDER",
        message: `No primary ${checkType} provider configured for this tenant.`,
      });
    }

    return {
      primary: await this.toResolvedProvider(primaryConfig),
      fallback: fallbackConfig ? await this.toResolvedProvider(fallbackConfig) : undefined,
    };
  }
}
