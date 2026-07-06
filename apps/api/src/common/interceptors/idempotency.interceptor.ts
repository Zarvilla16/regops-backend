import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import * as crypto from "crypto";
import { Observable, of } from "rxjs";
import { tap } from "rxjs/operators";
import { IdempotencyKeyEntity } from "@regops/db";
import { IDEMPOTENT_KEY } from "../decorators/idempotent.decorator";

const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Implements the Idempotency-Key contract (non-negotiable #3): a write
 * request replayed with the same key within 24h returns the original
 * response instead of re-executing. Requires a tenant-scoped QueryRunner
 * (see TenantContextMiddleware) since idempotency_key has RLS enabled.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const isIdempotent = this.reflector.getAllAndOverride<boolean | undefined>(IDEMPOTENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!isIdempotent) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const key = request.header("idempotency-key");
    const tenantId = request.effectiveTenantId;
    const queryRunner = request.queryRunner;

    if (!key || !tenantId || !queryRunner) {
      return next.handle();
    }

    const requestHash = crypto
      .createHash("sha256")
      .update(`${request.method}:${request.originalUrl}:${JSON.stringify(request.body ?? {})}`)
      .digest("hex");

    const repo = queryRunner.manager.getRepository(IdempotencyKeyEntity);
    const existing = await repo.findOne({ where: { tenantId, key } });

    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ConflictException({
          code: "IDEMPOTENCY_KEY_CONFLICT",
          message: "This Idempotency-Key was already used with a different request body.",
        });
      }
      response.status(existing.responseStatus);
      return of(existing.responseBody);
    }

    return next.handle().pipe(
      tap((data) => {
        void repo.save(
          repo.create({
            tenantId,
            key,
            requestHash,
            responseStatus: response.statusCode,
            responseBody: (data ?? null) as object,
            expiresAt: new Date(Date.now() + IDEMPOTENCY_WINDOW_MS),
          }),
        );
      }),
    );
  }
}
