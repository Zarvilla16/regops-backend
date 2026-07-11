import { Type } from "class-transformer";
import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import { CustomerType } from "@regops/shared";
import { IsElevenDigitId } from "../pipes/bvn-nin-validator";
import { CreatePepDetailsDto } from "./pep-details.dto";

export class CreateCustomerDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  cbsCustomerId!: string;

  @IsOptional()
  @IsElevenDigitId()
  bvn?: string;

  @IsOptional()
  @IsElevenDigitId()
  nin?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  fullName!: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  @IsEnum(CustomerType)
  customerType!: CustomerType;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  occupation?: string;

  @IsOptional()
  @IsString()
  @Length(2, 2)
  country?: string;

  @IsOptional()
  @IsString()
  @Length(2, 2)
  nationality?: string;

  @IsInt()
  @Min(1)
  @Max(3)
  kycTier!: number;

  @IsDateString()
  onboardedAt!: string;

  /** Also settable directly, since customerType === PEP doesn't cover a PEP
   * whose customerType is otherwise INDIVIDUAL/SME/etc. (Section 2). Either
   * signal being true requires `pepDetails` below and routes the new
   * customer to PENDING_EDD_APPROVAL instead of ACTIVE — see
   * CustomersService.create(). */
  @IsOptional()
  @IsBoolean()
  isPep?: boolean;

  @ValidateIf((o: CreateCustomerDto) => o.customerType === CustomerType.PEP || o.isPep === true)
  @ValidateNested()
  @Type(() => CreatePepDetailsDto)
  pepDetails?: CreatePepDetailsDto;
}
