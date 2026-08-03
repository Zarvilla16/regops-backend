import { IsOptional, IsString } from "class-validator";

export class CloseCaseDto {
  @IsOptional()
  @IsString()
  closureReason?: string;
}
