import { IsEnum, IsString, MinLength } from "class-validator";
import { AlertCloseCategory } from "@regops/shared";

export class CloseAlertDto {
  @IsEnum(AlertCloseCategory)
  category!: AlertCloseCategory;

  @IsString()
  @MinLength(1)
  reason!: string;
}
