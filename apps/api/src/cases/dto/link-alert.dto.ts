import { IsUUID } from "class-validator";

export class LinkAlertDto {
  @IsUUID()
  alertId!: string;
}
