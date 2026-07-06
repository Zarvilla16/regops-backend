import { createParamDecorator, ExecutionContext } from "@nestjs/common";

/**
 * The tenant id that should scope the current request's queries. Equal to
 * the caller's JWT tenantId, unless the caller is SUPER_ADMIN and supplied a
 * valid X-Tenant-Override header, in which case TenantContextMiddleware has
 * already validated and resolved it here.
 */
export const CurrentTenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest();
    return request.effectiveTenantId as string;
  },
);
