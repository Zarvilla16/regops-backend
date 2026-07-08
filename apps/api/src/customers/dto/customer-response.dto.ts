import type { CustomerDto } from "@regops/shared";

/**
 * The masked-PII response shape returned by every customer endpoint except
 * GET /customers/:id/pii — bvn/nin are masked (e.g. "*******1234") by
 * CustomersService.toDto(). Same wire shape as CustomerPiiDto; only the
 * content of bvn/nin differs, so this is a type alias, not a separate class
 * — this codebase maps entities to plain response objects in the service
 * layer (see UsersService.toDto()) rather than via serialization classes.
 */
export type CustomerResponseDto = CustomerDto;
