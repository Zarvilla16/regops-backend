import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import { QueryRunner } from "typeorm";

/**
 * The single Postgres connection TenantContextMiddleware opened for this
 * request and stamped with app.current_tenant_id / app.bypass_rls. Every
 * tenant-scoped query in a request MUST run through this connection (not the
 * pooled default connection) or Postgres RLS session variables won't apply.
 */
export const CurrentQueryRunner = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): QueryRunner => {
    const request = ctx.switchToHttp().getRequest();
    return request.queryRunner as QueryRunner;
  },
);
