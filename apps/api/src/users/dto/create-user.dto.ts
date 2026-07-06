import { IsEmail, IsEnum, IsString, MinLength } from "class-validator";
import { UserRole } from "@regops/shared";

export class CreateUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(12, { message: "password must be at least 12 characters" })
  password!: string;

  @IsString()
  @MinLength(1)
  fullName!: string;

  @IsEnum(UserRole)
  role!: UserRole;
}
