import { z } from "zod";
import { CustomerType } from "@regops/shared";

/**
 * Lives here (not in a shared package) because only this worker process
 * validates CSV rows — apps/api's upload endpoint just stores the raw file,
 * it never parses row content.
 *
 * Expected columns: cbs_customer_id,full_name,email,phone,bvn,nin,
 * date_of_birth,customer_type,occupation,country,nationality,kyc_tier,
 * onboarded_at. All except cbs_customer_id, full_name, customer_type,
 * kyc_tier, and onboarded_at are optional — csv-parse gives an empty string
 * for a blank cell, which optionalField() below turns into `undefined`.
 */
function optionalField<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((value) => (typeof value === "string" && value.trim() === "" ? undefined : value), schema.optional());
}

export const customerCsvRowSchema = z.object({
  cbs_customer_id: z.string().trim().min(1, "cbs_customer_id is required"),
  full_name: z.string().trim().min(1, "full_name is required"),
  email: optionalField(z.string().trim().email("must be a valid email")),
  phone: optionalField(z.string().trim().max(20)),
  bvn: optionalField(z.string().trim().regex(/^\d{11}$/, "BVN must be exactly 11 numeric digits")),
  nin: optionalField(z.string().trim().regex(/^\d{11}$/, "NIN must be exactly 11 numeric digits")),
  date_of_birth: optionalField(z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")),
  customer_type: z.nativeEnum(CustomerType, {
    errorMap: (issue, ctx) => {
      if (issue.code === "invalid_enum_value") {
        return { message: `Unknown customer type: ${ctx.data}` };
      }
      return { message: ctx.defaultError };
    },
  }),
  occupation: optionalField(z.string().trim().max(100)),
  country: optionalField(z.string().trim().length(2, "must be a 2-letter ISO country code")),
  nationality: optionalField(z.string().trim().length(2, "must be a 2-letter ISO country code")),
  kyc_tier: z
    .string()
    .trim()
    .refine((v) => ["1", "2", "3"].includes(v), "kyc_tier must be 1, 2, or 3")
    .transform((v) => Number(v)),
  onboarded_at: z.string().trim().min(1, "onboarded_at is required"),
});

export type CustomerCsvRow = z.infer<typeof customerCsvRowSchema>;

/** Maps a failed field to the error report's error_code column (see section 4.4's format). */
const FIELD_ERROR_CODES: Record<string, string> = {
  cbs_customer_id: "MISSING_CBS_CUSTOMER_ID",
  full_name: "MISSING_FULL_NAME",
  email: "INVALID_EMAIL",
  bvn: "INVALID_BVN",
  nin: "INVALID_NIN",
  date_of_birth: "INVALID_DATE_OF_BIRTH",
  customer_type: "INVALID_CUSTOMER_TYPE",
  country: "INVALID_COUNTRY",
  nationality: "INVALID_NATIONALITY",
  kyc_tier: "INVALID_KYC_TIER",
  onboarded_at: "INVALID_ONBOARDED_AT",
};

export function errorCodeForField(field: string): string {
  return FIELD_ERROR_CODES[field] ?? "INVALID_ROW";
}
