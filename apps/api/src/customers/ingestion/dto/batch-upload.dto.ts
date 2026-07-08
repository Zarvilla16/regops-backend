import { IsIn, IsOptional } from "class-validator";

export class BatchUploadDto {
  @IsOptional()
  @IsIn(["skip", "update"])
  duplicate_strategy?: "skip" | "update";
}
