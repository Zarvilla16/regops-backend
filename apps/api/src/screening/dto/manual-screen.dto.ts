import { IsArray, IsEnum, IsOptional } from "class-validator";
import { ScreeningCheckType } from "@regops/shared";

/** POST /screening/customers/:id/screen (Section 5.4/6) — always async,
 * regardless of which check types are requested. Defaults to PEP + adverse
 * media (the two checks that make sense to re-run manually outside the
 * dedicated synchronous /sanctions endpoint), but doesn't forbid requesting
 * SANCTIONS here too — a manual, non-blocking sanctions re-check post-onboarding
 * is a different operation from the mandatory sync pre-screen at creation time. */
export class ManualScreenDto {
  @IsOptional()
  @IsArray()
  @IsEnum(ScreeningCheckType, { each: true })
  checkTypes?: ScreeningCheckType[];
}
