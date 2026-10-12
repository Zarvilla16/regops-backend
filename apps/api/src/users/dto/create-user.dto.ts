import { IsEmail, IsEnum, IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { UserRole } from "@regops/shared";

export class CreateUserDto {
  @IsEmail()
  email!: string;

  /**
   * Optional. Omit it to invite the user by e-mail (they choose their own password through the link).
   * Supply it to create the account with a temporary password the user must change on first sign-in.
   */
  @IsOptional()
  @IsString()
  @MinLength(12, { message: "password must be at least 12 characters" })
  @MaxLength(128)
  password?: string;

  @IsString()
  @MinLength(1)
  fullName!: string;

  @IsEnum(UserRole)
  role!: UserRole;
}
