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
} from "class-validator";
import { CustomerStatus, CustomerType } from "@regops/shared";
import { IsElevenDigitId } from "../pipes/bvn-nin-validator";

/** Scoring-relevant fields (trigger a re-score on change, see CustomersService.SCORING_RELEVANT_FIELDS):
 * customerType, occupation, country, nationality, kycTier, isPep, isSanctioned. */
export class UpdateCustomerDto {
  @IsOptional()
  @IsElevenDigitId()
  bvn?: string;

  @IsOptional()
  @IsElevenDigitId()
  nin?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  fullName?: string;

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

  @IsOptional()
  @IsEnum(CustomerType)
  customerType?: CustomerType;

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

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3)
  kycTier?: number;

  @IsOptional()
  @IsBoolean()
  isPep?: boolean;

  @IsOptional()
  @IsBoolean()
  isSanctioned?: boolean;

  @IsOptional()
  @IsEnum(CustomerStatus)
  status?: CustomerStatus;
}
