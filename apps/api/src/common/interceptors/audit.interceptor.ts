import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Observable } from "rxjs";
import { tap } from "rxjs/operators";
import { AuthUserContext } from "@regops/shared";
import { AuditService } from "../../audit/audit.service";
import { AUDITABLE_KEY, AuditableMeta } from "../decorators/auditable.decorator";

/**
 * Generic best-effort audit logger for routes marked @Auditable() that have
 * no "before" state to diff (e.g. creation endpoints). It reuses the
 * request's own QueryRunner so the insert still goes through the
 * tenant-stamped connection (required by RLS), but it fires after the
 * handler's own transaction has already committed — so it is NOT atomic with
 * the business write. Endpoints that need that guarantee call
 * `AuditService.record(...)` directly inside their own transaction instead
 * (see UsersService, TenantsService).
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly auditService: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.getAllAndOverride<AuditableMeta | undefined>(AUDITABLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!meta) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest();

    return next.handle().pipe(
      tap((result) => {
        const currentUser = request.user as AuthUserContext | undefined;
        const queryRunner = request.queryRunner;
        const tenantId = request.effectiveTenantId ?? currentUser?.tenantId;
        if (!queryRunner || !tenantId) return;

        const afterState =
          result && typeof result === "object" ? (result as Record<string, unknown>) : null;

        void this.auditService.record(queryRunner, {
          tenantId,
          userId: currentUser?.sub ?? null,
          action: meta.action,
          entityType: meta.entity,
          entityId: (afterState?.id as string) ?? null,
          afterState,
          ipAddress: request.ip ?? null,
          userAgent: request.headers?.["user-agent"] ?? null,
        });
      }),
    );
  }
}
