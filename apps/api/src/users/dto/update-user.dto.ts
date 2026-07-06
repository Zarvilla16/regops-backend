import { IsEnum, IsOptional, IsString, MinLength } from "class-validator";
import { UserRole, UserStatus } from "@regops/shared";

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  fullName?: string;

  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;
}
