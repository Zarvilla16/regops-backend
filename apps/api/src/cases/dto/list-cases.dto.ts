import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Min } from "class-validator";

/** Comma-separated enum lists come through as plain strings and are split/
 * validated in the controller — same convention as ListAlertsDto. */
export class ListCasesDto {
  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  priority?: string;

  @IsOptional()
  @IsString()
  assigned_to?: string;

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 25;
}
