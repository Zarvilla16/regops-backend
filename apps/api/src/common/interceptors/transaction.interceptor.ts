import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from "@nestjs/common";
import { Observable } from "rxjs";
import { catchError, finalize, mergeMap } from "rxjs/operators";
import { QueryRunner } from "typeorm";

/**
 * Commits (or rolls back) the request-scoped transaction that
 * TenantContextMiddleware opens, and releases the connection.
 *
 * This must happen here — inside the interceptor chain, before the response
 * is handed back to Express — rather than in an Express `res.on("finish")`
 * handler: `finish` fires only after the response has already been written
 * to the client, so a caller could see a 200/201 for a write that hasn't
 * actually committed yet (or, worse, never commits at all because the
 * process is mid-shutdown by then). Registered as the outermost
 * APP_INTERCEPTOR so it runs after every other interceptor has finished
 * touching the connection.
 */
@Injectable()
export class TransactionInterceptor implements NestInterceptor {
  private readonly logger = new Logger(TransactionInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    const queryRunner: QueryRunner | undefined = req.queryRunner;

    if (!queryRunner) {
      return next.handle();
    }

    return next.handle().pipe(
      mergeMap(async (data) => {
        if (queryRunner.isTransactionActive) {
          await queryRunner.commitTransaction();
        }
        return data;
      }),
      catchError(async (err) => {
        if (queryRunner.isTransactionActive) {
          await queryRunner.rollbackTransaction();
        }
        throw err;
      }),
      finalize(() => {
        if (!queryRunner.isReleased) {
          queryRunner.release().catch((err: Error) => {
            this.logger.error("Failed to release request connection", err);
          });
        }
      }),
    );
  }
}
