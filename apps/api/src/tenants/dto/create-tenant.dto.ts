import { IsEnum, IsOptional, IsString, MinLength } from "class-validator";
import { TenantType } from "@regops/shared";

export class CreateTenantDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsEnum(TenantType)
  type!: TenantType;

  @IsOptional()
  @IsString()
  cbnLicenseNumber?: string;
}
