import { z } from "zod";
import { TransactionChannel, TransactionType } from "@regops/shared";

/**
 * One schema, reused by both ingestion paths (spec Section 7) — CSV rows
 * (SFTP-emulated) arrive as all-string values via csv-parse; JSON rows
 * (webhook) arrive already typed. `z.coerce`/optionalField below normalize
 * both shapes to the same parsed type, same spirit as
 * apps/worker/src/customer-ingestion/csv-row.schema.ts's optionalField.
 */
function optionalField<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((value) => (typeof value === "string" && value.trim() === "" ? undefined : value), schema.optional());
}

export const transactionRowSchema = z.object({
  cbs_transaction_id: z.string().trim().min(1, "cbs_transaction_id is required"),
  customer_cbs_id: z.string().trim().min(1, "customer_cbs_id is required"),
  account_number: z.string().trim().min(1, "account_number is required"),
  amount: z.coerce.number().positive("amount must be positive"),
  currency: optionalField(z.string().trim().length(3, "must be a 3-letter currency code")),
  type: z.nativeEnum(TransactionType, {
    errorMap: (issue, ctx) => (issue.code === "invalid_enum_value" ? { message: `Unknown transaction type: ${ctx.data}` } : { message: ctx.defaultError }),
  }),
  channel: z.nativeEnum(TransactionChannel, {
    errorMap: (issue, ctx) => (issue.code === "invalid_enum_value" ? { message: `Unknown channel: ${ctx.data}` } : { message: ctx.defaultError }),
  }),
  counterparty_account: optionalField(z.string().trim().max(50)),
  counterparty_bank: optionalField(z.string().trim().max(20)),
  counterparty_name: optionalField(z.string().trim().max(255)),
  narration: optionalField(z.string().trim()),
  reference: optionalField(z.string().trim().max(100)),
  balance_after: optionalField(z.coerce.number()),
  occurred_at: z.string().trim().min(1, "occurred_at is required"),
});

export type TransactionRow = z.infer<typeof transactionRowSchema>;

/** Maps a failed field to the error report's error_code column (spec Section 4.4/5.5's format). */
const FIELD_ERROR_CODES: Record<string, string> = {
  cbs_transaction_id: "MISSING_CBS_TRANSACTION_ID",
  customer_cbs_id: "MISSING_CUSTOMER_CBS_ID",
  account_number: "MISSING_ACCOUNT_NUMBER",
  amount: "INVALID_AMOUNT",
  currency: "INVALID_CURRENCY",
  type: "INVALID_TYPE",
  channel: "INVALID_CHANNEL",
  occurred_at: "INVALID_OCCURRED_AT",
};

export function errorCodeForField(field: string): string {
  return FIELD_ERROR_CODES[field] ?? "INVALID_ROW";
}
