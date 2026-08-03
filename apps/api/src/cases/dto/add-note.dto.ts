import { IsString } from "class-validator";

/** Non-empty-after-trim is enforced server-side in CaseNotesService (400
 * CONTENT_REQUIRED), not here — same split as SubmitCaseDto's rationale
 * (Task 8): a whitespace-only string must still reach the service to get
 * the spec's specific error code, not a generic class-validator message. */
export class AddNoteDto {
  @IsString()
  content!: string;
}
