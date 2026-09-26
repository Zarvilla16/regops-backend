import { IsOptional, IsString } from "class-validator";

/** Same reasoning as ConfirmReportDto — the service raises `400 REJECTION_REASON_REQUIRED`. */
export class RejectReportDto {
  @IsOptional()
  @IsString()
  reason?: string;
}
