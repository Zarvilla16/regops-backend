import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { Response } from "express";
import { ApiErrorResponse } from "@regops/shared";

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const { code, message, details } = this.normalize(exception, body);
      response.status(status).json({ success: false, error: { code, message, details } } satisfies ApiErrorResponse);
      return;
    }

    this.logger.error(
      exception instanceof Error ? exception.stack : String(exception),
    );
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred.",
      },
    } satisfies ApiErrorResponse);
  }

  private normalize(
    exception: HttpException,
    body: string | object,
  ): { code: string; message: string; details?: unknown } {
    if (typeof body === "string") {
      return { code: exception.name, message: body };
    }

    const anyBody = body as Record<string, unknown>;
    const code = (anyBody.code as string) ?? exception.name;
    const message =
      (anyBody.message as string | string[] | undefined) ?? exception.message;
    const details = Array.isArray(message) ? message : anyBody.details;

    return {
      code,
      message: Array.isArray(message) ? message.join(", ") : message,
      details,
    };
  }
}
