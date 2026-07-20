import { ArrayMaxSize, ArrayMinSize, IsArray } from "class-validator";

/** Spec Section 6.1 — row shape itself is validated by transactionRowSchema
 * (zod) in apps/worker, not here; this DTO only enforces the outer envelope
 * and the 1000-transaction batch cap. */
export class IngestWebhookDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  transactions!: Record<string, unknown>[];
}
