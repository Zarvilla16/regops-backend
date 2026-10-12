import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ALLOW_PASSWORD_CHANGE_PENDING_KEY } from "../../common/decorators/allow-password-change-pending.decorator";

/**
 * Global guard: an access token minted for an account that must change its temporary password carries
 * `mcp: true`. Such a token is only good for the handful of routes marked @AllowPasswordChangePending.
 *
 * It reads `request.user`, which TenantContextMiddleware has already populated from the verified JWT
 * (middleware runs before guards). Requests with no user (login, forgot/reset password, webhooks) pass
 * through untouched; JwtAuthGuard still rejects the unauthenticated ones on protected routes.
 */
@Injectable()
export class PasswordChangeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest().user as { mcp?: boolean } | undefined;
    if (!user?.mcp) return true;

    const allowed = this.reflector.getAllAndOverride<boolean>(ALLOW_PASSWORD_CHANGE_PENDING_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (allowed) return true;

    throw new ForbiddenException({
      code: "PASSWORD_CHANGE_REQUIRED",
      message: "You must change your temporary password before using the platform.",
    });
  }
}
