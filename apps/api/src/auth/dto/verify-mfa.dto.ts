import { IsString, Length, MinLength } from "class-validator";

export class VerifyMfaDto {
  @IsString()
  @MinLength(1)
  mfaToken!: string;

  @IsString()
  @Length(6, 6)
  code!: string;
}
