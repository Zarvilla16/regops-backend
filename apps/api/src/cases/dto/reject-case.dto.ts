import { IsString } from "class-validator";

export class RejectCaseDto {
  @IsString()
  reason!: string;
}
