import { IsEnum, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { AccountType } from "@regops/shared";

export class CreateCustomerAccountDto {
  @IsUUID()
  customer_id!: string;

  @IsString()
  @MaxLength(50)
  account_number!: string;

  @IsOptional()
  @IsEnum(AccountType)
  account_type?: AccountType;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  account_name?: string;
}
