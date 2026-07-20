import { Type } from "class-transformer";
import { IsInt, IsISO8601, IsOptional, IsString, Max, Min } from "class-validator";

/** GET /transactions and GET /customers/:id/transactions query params — filterable per spec Section 10.1. */
export class ListTransactionsDto {
  @IsOptional()
  @IsString()
  customer_id?: string;

  @IsOptional()
  @IsString()
  account_number?: string;

  @IsOptional()
  @IsString()
  counterparty_account?: string;

  @IsOptional()
  @IsString()
  counterparty_customer_id?: string;

  @IsOptional()
  @IsString()
  type?: string;

  /** Comma-separated TransactionChannel values. */
  @IsOptional()
  @IsString()
  channel?: string;

  @IsOptional()
  @Type(() => Number)
  amount_min?: number;

  @IsOptional()
  @Type(() => Number)
  amount_max?: number;

  @IsOptional()
  @IsISO8601()
  occurred_from?: string;

  @IsOptional()
  @IsISO8601()
  occurred_to?: string;

  @IsOptional()
  @IsString()
  source?: string;

  @IsOptional()
  @IsString()
  ingestion_batch_id?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 25;
}
