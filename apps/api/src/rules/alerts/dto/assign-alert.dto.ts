import { IsUUID } from "class-validator";

export class AssignAlertDto {
  @IsUUID()
  assignedTo!: string;
}
