import { IsUUID, ValidateIf } from "class-validator";

export class SwitchTenantDto {
  /** A tenant id to act as, or null to go back to the caller's own (home) tenant. */
  @ValidateIf((o: SwitchTenantDto) => o.tenantId !== null)
  @IsUUID()
  tenantId!: string | null;
}
