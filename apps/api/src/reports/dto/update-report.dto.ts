import { IsNumber, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

/** Only these two fields are editable, and only while status = DRAFT (Section 3.4). forbidNonWhitelisted rejects anything else. */
export class UpdateReportDto {
  @IsOptional()
  @IsString()
  @MaxLength(50000)
  narrative?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999999999999999)
  flaggedAmount?: number;
}
