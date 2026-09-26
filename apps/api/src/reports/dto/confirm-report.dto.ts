import { IsOptional, IsString } from "class-validator";

/** Optional at the DTO layer on purpose: an empty/missing value must surface as the spec's exact
 * `400 NFIU_REFERENCE_REQUIRED` from the service (after the 404/409/403 checks), not the generic validation error. */
export class ConfirmReportDto {
  @IsOptional()
  @IsString()
  nfiuReference?: string;
}
