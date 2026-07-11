import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Max, Min } from "class-validator";

/** GET /screening/checks query params — filterable per Section 6. */
export class ListScreeningChecksDto {
  @IsOptional()
  @IsString()
  customer_id?: string;

  /** Comma-separated ScreeningCheckType values. */
  @IsOptional()
  @IsString()
  check_type?: string;

  /** Comma-separated ScreeningCheckStatus values. */
  @IsOptional()
  @IsString()
  status?: string;

  /** Comma-separated ScreeningResultType values. */
  @IsOptional()
  @IsString()
  result?: string;

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

/** GET /screening/matches query params — defaults to the pending review
 * queue (Section 6: "Pending review queue (default filter)") unless a
 * caller explicitly asks for a different review_status. */
export class ListScreeningMatchesDto {
  @IsOptional()
  @IsString()
  customer_id?: string;

  @IsOptional()
  @IsString()
  review_status?: string;

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
