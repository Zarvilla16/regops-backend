import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsUUID } from "class-validator";

export class BulkAssignAlertsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsUUID("all", { each: true })
  ids!: string[];

  @IsUUID()
  assignedTo!: string;
}
