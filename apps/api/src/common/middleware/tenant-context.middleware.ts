import { Injectable, Logger, NestMiddleware } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { NextFunction, Request, Response } from "express";
import { DataSource } from "typeorm";
import { AuthUserContext, UserRole } from "@regops/shared";

const TENANT_OVERRIDE_HEADER = "x-tenant-override";

/**
 * Central multi-tenancy enforcement point. For every request:
 *  1. Decodes the access JWT (if present) to populate `req.user`.
 *
 *     NOTE: Nest's request pipeline runs middleware BEFORE guards, so
 *     `req.user` is not yet set by Passport/JwtAuthGuard at this point. This
 *     middleware performs its own (lightweight) verification so RLS context
 *     can be established up front; JwtAuthGuard still independently
 *     verifies the token again in the guard phase and is the one that
 *     actually rejects unauthenticated requests with 401. Verifying twice is
 *     redundant but keeps the two concerns (RLS context vs. route
 *     protection) cleanly separated.
 *  2. Resolves the "effective" tenant id for the request: normally the
 *     caller's own tenantId, unless the caller is SUPER_ADMIN and supplied
 *     X-Tenant-Override — this is the only path that may cross tenants.
 *  3. Opens one dedicated Postgres connection (QueryRunner) for the request,
 *     stamps `app.current_tenant_id` / `app.bypass_rls` via `set_config(..., true)`
 *     (transaction-local), and stores it on `req.queryRunner`. Every
 *     tenant-scoped repository call for this request MUST reuse this
 *     connection — pulling a fresh connection from the pool would carry no
 *     RLS context.
 *
 *     `set_config`'s third argument (`is_local`) only survives for the
 *     lifetime of an actual transaction — outside of one, Postgres commits
 *     and discards it as soon as that single statement finishes, so a later
 *     query on the very same connection would see it unset again. This
 *     middleware therefore opens the request's transaction here; services
 *     that open their own nested `startTransaction()`/`commitTransaction()`
 *     for atomic writes (see UsersService) safely become SAVEPOINTs within it
 *     (TypeORM tracks transaction depth), so this doesn't change their
 *     behavior. Session-level (`is_local = false`) was deliberately avoided:
 *     `release()` returns the underlying connection to the pg pool for reuse
 *     by a future, unrelated request, and a session-level setting would leak
 *     this request's tenant context into whatever picks up that connection
 *     next.
 *
 *     The transaction is committed by TransactionInterceptor, not here —
 *     that runs inside the interceptor chain, before Nest hands the response
 *     to Express, so a client never sees a success response for a write that
 *     hasn't actually committed. The `res.on("finish")` handler below is only
 *     a safety net for requests that never reach an interceptor at all (e.g.
 *     a path Express itself 404s with no matching controller): if the
 *     transaction is still open by the time the response finishes, something
 *     skipped it, so we roll back and release rather than leak the connection.
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TenantContextMiddleware.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const user = this.decodeUser(req);

    if (!user) {
      next();
      return;
    }

    (req as any).user = user;

    const overrideHeader = req.header(TENANT_OVERRIDE_HEADER);
    const isSuperAdmin = user.role === UserRole.SUPER_ADMIN;
    const effectiveTenantId = isSuperAdmin && overrideHeader ? overrideHeader : user.tenantId;
    const bypassRls = isSuperAdmin && Boolean(overrideHeader);

    (req as any).effectiveTenantId = effectiveTenantId;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    await queryRunner.query(
      `SELECT set_config('app.current_tenant_id', $1, true), set_config('app.bypass_rls', $2, true)`,
      [effectiveTenantId, bypassRls ? "true" : "false"],
    );

    (req as any).queryRunner = queryRunner;
    res.on("finish", () => {
      void (async () => {
        try {
          if (queryRunner.isTransactionActive) {
            await queryRunner.rollbackTransaction();
          }
        } catch (err) {
          this.logger.error("Failed to roll back an unclaimed request transaction", err as Error);
        } finally {
          if (!queryRunner.isReleased) {
            await queryRunner.release();
          }
        }
      })();
    });

    next();
  }

  private decodeUser(req: Request): AuthUserContext | null {
    const header = req.header("authorization");
    if (!header?.startsWith("Bearer ")) {
      return null;
    }

    const token = header.slice("Bearer ".length);
    try {
      return this.jwtService.verify<AuthUserContext>(token, {
        secret: this.configService.get<string>("jwt.accessSecret"),
      });
    } catch {
      return null;
    }
  }
}
