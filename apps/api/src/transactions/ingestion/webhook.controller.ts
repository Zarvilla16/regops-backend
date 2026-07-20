import { BadRequestException, Body, Controller, Post, Query, Req, RequestTimeoutException, Res, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Request, Response } from "express";
import { QueryRunner } from "typeorm";
import { TransactionIngestionJobData, TransactionSource } from "@regops/shared";
import { Idempotent } from "../../common/decorators/idempotent.decorator";
import { CurrentQueryRunner } from "../../common/decorators/current-query-runner.decorator";
import { CurrentTenant } from "../../common/decorators/current-tenant.decorator";
import { IngestionBatchService } from "./ingestion-batch.service";
import { TransactionIngestionQueueService } from "./ingestion-queue.service";
import { WebhookSignatureGuard } from "./webhook-signature.guard";
import { IngestWebhookDto } from "./dto/ingest-webhook.dto";

const SYNC_MAX_TRANSACTIONS = 50;
const SYNC_TIMEOUT_MS = 10_000;

/**
 * POST /transactions/ingest — spec Section 6. No JwtAuthGuard/RolesGuard
 * here: the caller is an external CBS/webhook sender, not a logged-in
 * RegOps user (see WebhookSignatureGuard's docblock and
 * TenantContextMiddleware's UNAUTHENTICATED_TENANT_HEADER_ROUTES for how
 * tenant context still gets established safely without a JWT).
 */
@ApiTags("transactions")
@UseGuards(WebhookSignatureGuard)
@Controller("transactions")
export class WebhookController {
  constructor(
    private readonly ingestionBatchService: IngestionBatchService,
    private readonly ingestionQueueService: TransactionIngestionQueueService,
  ) {}

  @Post("ingest")
  @Idempotent()
  async ingest(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() queryRunner: QueryRunner,
    @Body() dto: IngestWebhookDto,
    @Query("sync") sync: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const isSync = sync === "true";
    if (isSync && dto.transactions.length > SYNC_MAX_TRANSACTIONS) {
      throw new BadRequestException({
        code: "SYNC_BATCH_TOO_LARGE",
        message: `Synchronous mode supports at most ${SYNC_MAX_TRANSACTIONS} transactions per request.`,
      });
    }

    const batch = await this.ingestionBatchService.createQueued(
      queryRunner,
      tenantId,
      TransactionSource.WEBHOOK,
      req.header("idempotency-key") ?? null,
    );

    const jobData: TransactionIngestionJobData = {
      tenantId,
      batchId: batch.id,
      source: TransactionSource.WEBHOOK,
      rows: dto.transactions,
    };

    if (!isSync) {
      await this.ingestionQueueService.enqueue(jobData);
      res.status(202);
      return { batchId: batch.id, transactionCount: dto.transactions.length, status: "queued" };
    }

    try {
      const result = await this.ingestionQueueService.enqueueAndWait(jobData, SYNC_TIMEOUT_MS);
      return {
        batchId: batch.id,
        status: "completed",
        total: result.total,
        succeeded: result.succeeded,
        failed: result.failed,
      };
    } catch {
      throw new RequestTimeoutException({
        code: "SYNC_INGESTION_TIMEOUT",
        message: `Synchronous ingestion did not complete within ${SYNC_TIMEOUT_MS}ms; the batch is still processing asynchronously.`,
        details: { batchId: batch.id },
      });
    }
  }
}
