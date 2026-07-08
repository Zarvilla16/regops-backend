import type { CustomerDto } from "@regops/shared";

/**
 * The full-PII response shape — bvn/nin are unmasked plaintext. Only ever
 * returned by GET /customers/:id/pii, which requires COMPLIANCE_OFFICER+, a
 * `reason` query param, and is always audit-logged (action:
 * "customer.pii.view"). See customer-response.dto.ts for why this is a
 * type alias rather than a separate class.
 */
export type CustomerPiiDto = CustomerDto;
