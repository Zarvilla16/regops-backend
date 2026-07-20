import { Injectable, NotFoundException } from "@nestjs/common";
import { QueryRunner } from "typeorm";
import { IngestionBatchEntity } from "@regops/db";
import { IngestionBatchDto, IngestionBatchStatus, TransactionSource } from "@regops/shared";

@Injectable()
export class IngestionBatchService {
  toDto(batch: IngestionBatchEntity): IngestionBatchDto {
    return {
      id: batch.id,
      tenantId: batch.tenantId,
      source: batch.source,
      sourceReference: batch.sourceReference,
      status: batch.status,
      totalRows: batch.totalRows,
      processedRows: batch.processedRows,
      succeededRows: batch.succeededRows,
      failedRows: batch.failedRows,
      errorReportUrl: batch.errorReportUrl,
      startedAt: batch.startedAt ? batch.startedAt.toISOString() : null,
      completedAt: batch.completedAt ? batch.completedAt.toISOString() : null,
      createdAt: batch.createdAt.toISOString(),
    };
  }

  /** Webhook path only — the SFTP-emulated path creates its own batch row
   * from apps/worker's sftp-polling.service.ts (batch creation happens at
   * file-discovery time, which only the poller observes). */
  async createQueued(
    queryRunner: QueryRunner,
    tenantId: string,
    source: TransactionSource,
    sourceReference: string | null,
  ): Promise<IngestionBatchEntity> {
    const repo = queryRunner.manager.getRepository(IngestionBatchEntity);
    return repo.save(
      repo.create({
        tenantId,
        source,
        sourceReference,
        status: IngestionBatchStatus.QUEUED,
      }),
    );
  }

  async findAll(
    queryRunner: QueryRunner,
    tenantId: string,
    page: number,
    limit: number,
  ): Promise<{ data: IngestionBatchDto[]; total: number }> {
    const [rows, total] = await queryRunner.manager.getRepository(IngestionBatchEntity).findAndCount({
      where: { tenantId },
      order: { createdAt: "DESC" },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { data: rows.map((r) => this.toDto(r)), total };
  }

  async findById(queryRunner: QueryRunner, tenantId: string, id: string): Promise<IngestionBatchEntity> {
    const batch = await queryRunner.manager.getRepository(IngestionBatchEntity).findOne({ where: { tenantId, id } });
    if (!batch) {
      throw new NotFoundException({ code: "INGESTION_BATCH_NOT_FOUND", message: "Ingestion batch not found." });
    }
    return batch;
  }
}
