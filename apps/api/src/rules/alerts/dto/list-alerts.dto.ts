import { Type } from "class-transformer";
import { IsInt, IsISO8601, IsOptional, IsString, IsUUID, Matches, MaxLength, Min } from "class-validator";

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

  /** A user id, or the literal "unassigned" for alerts with no assignee. */
  @IsOptional()
  @Matches(/^(unassigned|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i, {
    message: "assigned_to must be a user id or 'unassigned'",
  })
  assigned_to?: string;

  /** Console-facing aliases: comma-separated scenario types (same as scenario_type). */
  @IsOptional()
  @IsString()
  scenario?: string;

  /** Console-facing date range on the alert's creation date, inclusive, YYYY-MM-DD. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "created_from must be YYYY-MM-DD" })
  created_from?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "created_to must be YYYY-MM-DD" })
  created_to?: string;

  /** Case-insensitive substring match against the alert's customer name. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

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
