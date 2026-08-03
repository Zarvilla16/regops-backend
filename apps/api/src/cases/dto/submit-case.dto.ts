import { IsString } from "class-validator";

/** Non-empty-after-trim is enforced in CasesService.submit (400
 * ESCALATION_RATIONALE_REQUIRED), not here — a whitespace-only string must
 * still reach the service to get that specific error code. */
export class SubmitCaseDto {
  @IsString()
  escalationRationale!: string;
}
