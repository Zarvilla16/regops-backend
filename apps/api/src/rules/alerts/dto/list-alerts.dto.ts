import { Type } from "class-transformer";
import { IsInt, IsISO8601, IsOptional, IsString, IsUUID, Min } from "class-validator";

/** Section 9.1's filters — comma-separated enum lists come through as plain
 * strings and are split/validated in the controller (same convention as
 * ListTransactionsDto's `channel` field). */
export class ListAlertsDto {
  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  severity?: string;

  @IsOptional()
  @IsString()
  scenario_type?: string;

  @IsOptional()
  @IsUUID()
  rule_id?: string;

  @IsOptional()
  @IsUUID()
  customer_id?: string;

  @IsOptional()
  @IsUUID()
  assigned_to?: string;

  @IsOptional()
  @IsISO8601()
  first_fired_from?: string;

  @IsOptional()
  @IsISO8601()
  first_fired_to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  min_fire_count?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 50;
}
