import { IsEnum, IsOptional, IsUUID } from "class-validator";
import { CasePriority } from "@regops/shared";

/** Section 3.1: customerId and alertId are both optional at the type level —
 * CasesService.create() enforces that at least one resolves to a customer
 * (400 CUSTOMER_REQUIRED otherwise), which can't be expressed as a single
 * class-validator decorator without a custom validator, so it's a service-
 * level check instead (matches the spec's own field-resolution ordering). */
export class CreateCaseDto {
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsUUID()
  alertId?: string;

  @IsOptional()
  @IsEnum(CasePriority)
  priority?: CasePriority;
}
