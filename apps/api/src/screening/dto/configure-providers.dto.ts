import { Type } from "class-transformer";
import { IsArray, IsBoolean, IsEnum, IsOptional, IsString, MinLength, ValidateNested } from "class-validator";
import { ScreeningCheckType, ScreeningProviderName } from "@regops/shared";

/**
 * PUT /screening/providers's request shape — replaces the full set of
 * per-check-type provider configs for the tenant in one call (Section 6:
 * "Configure primary/fallback per check_type"). Not in the Section 4.1 file
 * tree under that literal name (which lists screen-customer.dto.ts instead,
 * whose exact purpose the spec never spells out) — this is the DTO that
 * endpoint actually needs, so it lives here rather than as an unused
 * placeholder file.
 */
export class ConfigureProviderEntryDto {
  @IsEnum(ScreeningCheckType)
  checkType!: ScreeningCheckType;

  @IsEnum(ScreeningProviderName)
  provider!: ScreeningProviderName;

  @IsBoolean()
  isPrimary!: boolean;

  @IsBoolean()
  isFallback!: boolean;

  @IsString()
  @MinLength(1)
  credentialsRef!: string;

  @IsOptional()
  config?: Record<string, unknown>;
}

export class ConfigureProvidersDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ConfigureProviderEntryDto)
  providers!: ConfigureProviderEntryDto[];
}
