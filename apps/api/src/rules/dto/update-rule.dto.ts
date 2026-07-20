import { IsBoolean, IsObject, IsOptional, IsString, MinLength } from "class-validator";

/**
 * PATCH /rules/:id (Section 9.2). `reason` is mandatory when `isActive`
 * transitions to false (RulesService.update enforces this itself — the
 * validator here only checks the string isn't empty when present).
 */
export class UpdateRuleDto {
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  @MinLength(1)
  reason?: string;
}
