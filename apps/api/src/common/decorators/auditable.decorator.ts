import { SetMetadata } from "@nestjs/common";

export interface AuditableMeta {
  entity: string;
  action: string;
}

export const AUDITABLE_KEY = "auditable";

/**
 * Marks a controller route as auditable for AuditInterceptor. Suitable for
 * simple create-style endpoints where there is no "before" state to diff and
 * strict same-transaction atomicity isn't required (e.g. tenant creation).
 *
 * Endpoints where the audit row MUST be written atomically with the business
 * write (e.g. user create/update, login) instead call
 * `AuditService.recordInTransaction(...)` explicitly inside the service
 * method, using the request's own QueryRunner/transaction — see
 * UsersService for the pattern.
 */
export const Auditable = (meta: AuditableMeta) => SetMetadata(AUDITABLE_KEY, meta);
