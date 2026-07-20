import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import * as crypto from "crypto";
import { TenantEntity } from "@regops/db";

const SIGNATURE_HEADER = "x-regops-signature";
const TIMESTAMP_HEADER = "x-regops-timestamp";
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * Verifies the HMAC-SHA256 signature spec Section 6.2 describes:
 *   string_to_sign = timestamp + '.' + raw_body
 *   signature = HMAC-SHA256(tenant.webhook_secret, string_to_sign)
 *
 * This is the actual authentication for this route — TenantContextMiddleware
 * only opened a tenant-scoped connection on the strength of an unverified
 * X-Tenant-Id header (see that middleware's docblock); this guard is what
 * turns that claim into a verified one, or rejects it before the handler
 * (and thus before TransactionInterceptor commits anything) ever runs.
 *
 * Needs the RAW request body bytes (not the parsed JSON) since whitespace/key
 * order affects the signature the sender computed — see main.ts's
 * `NestFactory.create(AppModule, { rawBody: true })` for where req.rawBody
 * comes from; Nest populates both req.rawBody and the normal parsed req.body
 * from the same read, so the controller's DTO binding is unaffected.
 */
@Injectable()
export class WebhookSignatureGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const tenantId = request.effectiveTenantId as string | undefined;
    const queryRunner = request.queryRunner;

    if (!tenantId || !queryRunner) {
      throw new UnauthorizedException({ code: "TENANT_CONTEXT_MISSING", message: "X-Tenant-Id header is required." });
    }

    const signatureHeader = request.header(SIGNATURE_HEADER) as string | undefined;
    const timestampHeader = request.header(TIMESTAMP_HEADER) as string | undefined;
    const rawBody: Buffer | undefined = request.rawBody;

    if (!signatureHeader || !timestampHeader || !rawBody) {
      throw new UnauthorizedException({
        code: "WEBHOOK_SIGNATURE_MISSING",
        message: "X-RegOps-Signature and X-RegOps-Timestamp headers are required.",
      });
    }

    const timestampMs = Number(timestampHeader) * 1000;
    if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > MAX_CLOCK_SKEW_MS) {
      throw new UnauthorizedException({ code: "WEBHOOK_TIMESTAMP_STALE", message: "Request timestamp is too old or invalid." });
    }

    // Looked up on the request's own tenant-scoped connection — the tenant
    // table has no RLS (it's the tenant registry itself, not tenant-owned
    // data), so this is just a plain findOne regardless of RLS context.
    const tenant = await queryRunner.manager.getRepository(TenantEntity).findOne({ where: { id: tenantId } });
    const webhookSecret = (tenant?.config as { transactions?: { webhookSecret?: string } } | undefined)?.transactions
      ?.webhookSecret;

    if (!tenant || !webhookSecret) {
      throw new UnauthorizedException({ code: "WEBHOOK_NOT_CONFIGURED", message: "Webhook ingestion is not configured for this tenant." });
    }

    const stringToSign = `${timestampHeader}.${rawBody.toString("utf8")}`;
    const expectedSignature = crypto.createHmac("sha256", webhookSecret).update(stringToSign).digest("hex");

    const provided = signatureHeader.startsWith("sha256=") ? signatureHeader.slice("sha256=".length) : signatureHeader;
    const expectedBuf = Buffer.from(expectedSignature, "hex");
    const providedBuf = Buffer.from(provided, "hex");

    // Never logged — see the request logging middleware/interceptors, none
    // of which touch headers directly; this guard itself never console.logs
    // signatureHeader/webhookSecret under any code path, including errors.
    const signatureValid =
      expectedBuf.length === providedBuf.length && crypto.timingSafeEqual(expectedBuf, providedBuf);

    if (!signatureValid) {
      throw new UnauthorizedException({ code: "WEBHOOK_SIGNATURE_INVALID", message: "Signature verification failed." });
    }

    return true;
  }
}
