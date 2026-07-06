import { IsString, Length } from "class-validator";

/** Used by both POST /auth/mfa/enable and POST /auth/mfa/disable. */
export class MfaCodeDto {
  @IsString()
  @Length(6, 6)
  code!: string;
}
