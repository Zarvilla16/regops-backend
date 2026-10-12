import { IsString, MaxLength, MinLength } from "class-validator";

export class UpdateCurrentTenantDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;
}
