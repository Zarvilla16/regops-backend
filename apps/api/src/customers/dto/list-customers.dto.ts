import { Transform, Type } from "class-transformer";
import { IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import { CustomerStatus } from "@regops/shared";

const SORTABLE_FIELDS = [
  "full_name",
  "risk_score",
  "onboarded_at",
  "-full_name",
  "-risk_score",
  "-onboarded_at",
] as const;

/** Query params match section 4.3's wire names exactly (snake_case) — these are URL query strings, not internal properties. */
export class ListCustomersDto {
  @IsOptional()
  @IsString()
  q?: string;

  /** Comma-separated RiskLevel values, e.g. "HIGH,CRITICAL". */
  @IsOptional()
  @IsString()
  risk_level?: string;

  /** Comma-separated CustomerType values. */
  @IsOptional()
  @IsString()
  customer_type?: string;

  @IsOptional()
  @IsIn(Object.values(CustomerStatus))
  status?: CustomerStatus;

  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : value === "true"))
  @IsBoolean()
  is_pep?: boolean;

  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : value === "true"))
  @IsBoolean()
  is_sanctioned?: boolean;

  @IsOptional()
  @IsDateString()
  onboarded_from?: string;

  @IsOptional()
  @IsDateString()
  onboarded_to?: string;

  @IsOptional()
  @IsIn(SORTABLE_FIELDS)
  sort?: (typeof SORTABLE_FIELDS)[number];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 25;
}
