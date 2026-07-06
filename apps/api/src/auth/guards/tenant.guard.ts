import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";

/**
 * Defense-in-depth check that a tenant context was actually established by
 * TenantContextMiddleware for this request (req.user + req.effectiveTenantId
 * + req.queryRunner). The primary enforcement of tenant isolation is
 * Postgres RLS on the request's QueryRunner connection plus explicit
 * tenant_id scoping in each service's queries; this guard only guards
 * against the request reaching a handler with no tenant context at all.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();

    if (!request.user || !request.effectiveTenantId || !request.queryRunner) {
      throw new UnauthorizedException({
        code: "TENANT_CONTEXT_MISSING",
        message: "No tenant context could be established for this request.",
      });
    }

    return true;
  }
}
