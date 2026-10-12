import { SetMetadata } from "@nestjs/common";

export const ALLOW_PASSWORD_CHANGE_PENDING_KEY = "allowPasswordChangePending";

/**
 * Marks a route as usable by an account that must still change its temporary password. Every other
 * authenticated route answers 403 PASSWORD_CHANGE_REQUIRED for such an account (see PasswordChangeGuard).
 */
export const AllowPasswordChangePending = () => SetMetadata(ALLOW_PASSWORD_CHANGE_PENDING_KEY, true);
