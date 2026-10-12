import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from "class-validator";

export class ListAuditLogsDto {
  @IsOptional()
  @IsUUID()
  user_id?: string;

  /** Comma-separated entity types, e.g. "alert,case". */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  entity_type?: string;

  @IsOptional()
  @IsUUID()
  entity_id?: string;

  /** Case-insensitive substring of the action name, e.g. "login" or "alert.assign". */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  action?: string;

  /** Inclusive YYYY-MM-DD bounds on created_at. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "date_from must be YYYY-MM-DD" })
  date_from?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "date_to must be YYYY-MM-DD" })
  date_to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 50;
}
