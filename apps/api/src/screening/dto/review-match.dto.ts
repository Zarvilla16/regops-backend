import { IsEnum, IsString, MinLength } from "class-validator";
import { MatchDecision } from "@regops/shared";

/** Section 6.1: TRUE_POSITIVE/FALSE_POSITIVE, always with a reason — the
 * mock frontend's screening.ts already established this exact reason-required
 * pattern; this is the real backend endpoint it was standing in for. */
export class ReviewMatchDto {
  @IsEnum(MatchDecision)
  decision!: MatchDecision;

  @IsString()
  @MinLength(1)
  decisionReason!: string;
}
