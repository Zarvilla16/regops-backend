import { IsUUID, ValidateIf } from "class-validator";

/** assignedTo is required but nullable (null = unassign) — @ValidateIf skips
 * @IsUUID() only when the value is the literal null, same pattern already
 * used for CreateCustomerDto.pepDetails' conditional validation. */
export class AssignCaseDto {
  @ValidateIf((o: AssignCaseDto) => o.assignedTo !== null)
  @IsUUID()
  assignedTo!: string | null;
}
