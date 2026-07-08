import {
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
import { CustomerType } from "@regops/shared";
import { IsElevenDigitId } from "../pipes/bvn-nin-validator";

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
}
