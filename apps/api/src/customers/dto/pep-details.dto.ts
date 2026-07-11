import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  MinLength,
  ValidateIf,
} from "class-validator";
import { PepCategory, PepStatus } from "@regops/shared";

/** Required whenever the parent CreateCustomerDto's effective PEP flag is true
 * (customerType === PEP or isPep === true) — see CreateCustomerDto's own
 * @ValidateIf on `pepDetails` below, and CustomersService.create(). */
export class CreatePepDetailsDto {
  @IsEnum(PepCategory)
  pepCategory!: PepCategory;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  pepPosition!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  pepInstitution!: string;

  @IsString()
  @Length(2, 2)
  pepCountry!: string;

  @IsEnum(PepStatus)
  pepStatus!: PepStatus;

  @IsDateString()
  pepStartDate!: string;

  @IsOptional()
  @IsDateString()
  pepEndDate?: string;

  @IsOptional()
  @IsBoolean()
  isPepByAssociation?: boolean;

  /** Required when isPepByAssociation is true — this is the actual PEP the
   * subject is associated with, not the subject's own (non-PEP) role. */
  @ValidateIf((o: CreatePepDetailsDto) => o.isPepByAssociation === true)
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  associatedPepName?: string;

  @IsString()
  @MinLength(1)
  sourceOfWealth!: string;

  @IsDateString()
  nextReviewDate!: string;
}
