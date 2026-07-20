import { parse } from "csv-parse";
import { Readable } from "stream";
import { DataSource, QueryRunner } from "typeorm";
import { RiskFactorConfigEntity, TenantEntity } from "@regops/db";
import {
  IngestedTransactionSummary,
  IngestionBatchStatus,
  TransactionIngestionJobData,
  TransactionIngestionJobResult,
  UnknownCustomerMode,
} from "@regops/shared";
import type { FileStorage } from "@regops/file-storage";
import { errorCodeForField, transactionRowSchema, TransactionRow } from "./transaction-row.schema";
import { newTransactionId, resolveAccounts, resolveCounterpartyAccounts, resolveCustomers } from "./resolution";

const CHUNK_SIZE = 500; // spec Section 5.4
// Lower than customer-ingestion's CONCURRENCY=6 — each chunk here does more
// round trips per row-set (customer + account + counterparty resolution,
// THEN the insert), so fewer chunks run in parallel for the same connection budget.
const CONCURRENCY = 4;

const INSERT_COLUMNS = [
  "id",
  "tenant_id",
  "cbs_transaction_id",
  "customer_id",
  "account_number",
  "amount",
  "currency",
  "type",
  "channel",
  "counterparty_account",
  "counterparty_bank",
  "counterparty_name",
  "counterparty_customer_id",
  "narration",
  "reference",
  "balance_after",
  "occurred_at",
  "source",
  "ingestion_batch_id",
];

interface ErrorRow {
  rowNumber: number;
  cbsTransactionId: string;
  errorCode: string;
  errorMessage: string;
}

interface RawRow {
  rowNumber: number;
  raw: Record<string, unknown>;
}

/** Duplicated from ingestion-job.processor.ts / RescoreSchedulerService — see
 * either's docblock for why (no shared runtime between apps/api and apps/worker). */
async function withTenantContext<T>(dataSource: DataSource, tenantId: string, fn: (qr: QueryRunner) => Promise<T>): Promise<T> {
  const qr = dataSource.createQueryRunner();
  await qr.connect();
  await qr.startTransaction();
  try {
    await qr.query(`SELECT set_config('app.current_tenant_id', $1, true), set_config('app.bypass_rls', 'false', true)`, [tenantId]);
    const result = await fn(qr);
    await qr.commitTransaction();
    return result;
  } catch (err) {
    if (qr.isTransactionActive) {
      await qr.rollbackTransaction();
    }
    throw err;
  } finally {
    await qr.release();
  }
}

async function* rowSource(storage: FileStorage, data: TransactionIngestionJobData): AsyncGenerator<RawRow> {
  if (data.rows) {
    let rowNumber = 1;
    for (const raw of data.rows) {
      rowNumber += 1;
      yield { rowNumber, raw: raw as Record<string, unknown> };
    }
    return;
  }

  const readStream = await storage.getReadStream(data.storageKey as string);
  const parser = readStream.pipe(parse({ columns: true, skip_empty_lines: true, trim: true }));
  let rowNumber = 1;
  for await (const raw of parser as AsyncIterable<Record<string, string>>) {
    rowNumber += 1;
    yield { rowNumber, raw };
  }
}

async function countTotalRows(storage: FileStorage, data: TransactionIngestionJobData): Promise<number> {
  if (data.rows) return data.rows.length;
  const stream = await storage.getReadStream(data.storageKey as string);
  let count = 0;
  for await (const chunk of stream) {
    for (const byte of chunk as Buffer) {
      if (byte === 0x0a) count += 1;
    }
  }
  return Math.max(count - 1, 0); // header row doesn't count
}

export async function processTransactionIngestionJob(
  dataSource: DataSource,
  storage: FileStorage,
  data: TransactionIngestionJobData,
  onProgress: (percent: number) => Promise<void> = async () => undefined,
): Promise<TransactionIngestionJobResult> {
  const unknownCustomerMode = await withTenantContext(dataSource, data.tenantId, async (qr) => {
    const tenant = await qr.manager.getRepository(TenantEntity).findOneOrFail({ where: { id: data.tenantId } });
    const config = tenant.config as { ingestion?: { unknownCustomerMode?: UnknownCustomerMode } };
    await qr.manager.query(`UPDATE ingestion_batch SET status = $1, started_at = now() WHERE id = $2 AND tenant_id = $3`, [
      IngestionBatchStatus.PROCESSING,
      data.batchId,
      data.tenantId,
    ]);
    return config.ingestion?.unknownCustomerMode ?? UnknownCustomerMode.REJECT;
  });

  const configByType = await withTenantContext(dataSource, data.tenantId, async (qr) => {
    const configs = await qr.manager.getRepository(RiskFactorConfigEntity).find({ where: { tenantId: data.tenantId, isActive: true } });
    return new Map(configs.map((c) => [c.factorType, c]));
  });

  const totalRows = await countTotalRows(storage, data);

  const errorRows: ErrorRow[] = [];
  const insertedTransactions: IngestedTransactionSummary[] = [];
  let succeeded = 0;
  let failed = 0;
  let processed = 0;

  const processChunk = async (rows: RawRow[]): Promise<void> => {
    await withTenantContext(dataSource, data.tenantId, async (qr) => {
      const validRows: { rowNumber: number; row: TransactionRow }[] = [];
      for (const { rowNumber, raw } of rows) {
        const parsed = transactionRowSchema.safeParse(raw);
        if (!parsed.success) {
          failed += 1;
          const issue = parsed.error.issues[0];
          errorRows.push({
            rowNumber,
            cbsTransactionId: String(raw.cbs_transaction_id ?? ""),
            errorCode: errorCodeForField(String(issue.path[0] ?? "")),
            errorMessage: issue.message,
          });
          continue;
        }
        validRows.push({ rowNumber, row: parsed.data });
      }
      if (validRows.length === 0) return;

      // Section 7.1: bulk resolution, no N+1 — full_name isn't part of the
      // transaction row schema, so an auto-created stub always falls back to
      // "Unknown Customer <cbs_id>" (spec's documented fallback, not a gap).
      const customerMap = await resolveCustomers(
        qr,
        data.tenantId,
        validRows.map((v) => v.row.customer_cbs_id),
        unknownCustomerMode,
        new Map(),
        configByType,
        null,
      );

      const resolvedRows: { rowNumber: number; row: TransactionRow; customerId: string }[] = [];
      for (const { rowNumber, row } of validRows) {
        const resolution = customerMap.get(row.customer_cbs_id);
        if (!resolution) {
          failed += 1;
          errorRows.push({
            rowNumber,
            cbsTransactionId: row.cbs_transaction_id,
            errorCode: "UNKNOWN_CUSTOMER",
            errorMessage: `No customer found for customer_cbs_id "${row.customer_cbs_id}".`,
          });
          continue;
        }
        resolvedRows.push({ rowNumber, row, customerId: resolution.customerId });
      }

      if (resolvedRows.length > 0) {
        await resolveAccounts(
          qr,
          data.tenantId,
          resolvedRows.map((r) => ({ accountNumber: r.row.account_number, customerId: r.customerId })),
        );
        const counterpartyMap = await resolveCounterpartyAccounts(
          qr,
          data.tenantId,
          resolvedRows.map((r) => r.row.counterparty_account),
        );

        const insertRows = resolvedRows.map((r) => ({
          id: newTransactionId(),
          rowNumber: r.rowNumber,
          row: r.row,
          customerId: r.customerId,
          counterpartyCustomerId: r.row.counterparty_account ? counterpartyMap.get(r.row.counterparty_account) ?? null : null,
        }));

        const values: unknown[] = [];
        const placeholders: string[] = [];
        for (const ir of insertRows) {
          const base = values.length;
          placeholders.push(`(${INSERT_COLUMNS.map((_, i) => `$${base + i + 1}`).join(",")})`);
          values.push(
            ir.id,
            data.tenantId,
            ir.row.cbs_transaction_id,
            ir.customerId,
            ir.row.account_number,
            ir.row.amount,
            ir.row.currency ?? "NGN",
            ir.row.type,
            ir.row.channel,
            ir.row.counterparty_account ?? null,
            ir.row.counterparty_bank ?? null,
            ir.row.counterparty_name ?? null,
            ir.counterpartyCustomerId,
            ir.row.narration ?? null,
            ir.row.reference ?? null,
            ir.row.balance_after ?? null,
            ir.row.occurred_at,
            data.source,
            data.batchId,
          );
        }

        // ON CONFLICT DO NOTHING (spec Section 5.5's sanctioned "graceful
        // dedup" alternative to pre-checking + retrying a COPY) — a
        // client-generated id per row lets us tell exactly which input rows
        // were skipped as duplicates from the RETURNING set, which a bulk
        // insert on the natural key alone couldn't distinguish unambiguously.
        const sql = `INSERT INTO transaction (${INSERT_COLUMNS.join(",")}) VALUES ${placeholders.join(",")} ON CONFLICT (tenant_id, cbs_transaction_id, occurred_at) DO NOTHING RETURNING id`;
        const insertedIdRows: { id: string }[] = await qr.manager.query(sql, values);
        const insertedIds = new Set(insertedIdRows.map((r) => r.id));

        for (const ir of insertRows) {
          if (insertedIds.has(ir.id)) {
            succeeded += 1;
            insertedTransactions.push({
              transactionId: ir.id,
              customerId: ir.customerId,
              amount: Number(ir.row.amount).toFixed(2),
              currency: ir.row.currency ?? "NGN",
              type: ir.row.type,
              channel: ir.row.channel,
              counterpartyCustomerId: ir.counterpartyCustomerId,
              occurredAt: new Date(ir.row.occurred_at).toISOString(),
              source: data.source,
            });
          } else {
            failed += 1;
            errorRows.push({
              rowNumber: ir.rowNumber,
              cbsTransactionId: ir.row.cbs_transaction_id,
              errorCode: "DUPLICATE_TRANSACTION",
              errorMessage: "A transaction with this cbs_transaction_id and occurred_at already exists.",
            });
          }
        }
      }

      await qr.manager.query(`UPDATE ingestion_batch SET processed_rows = processed_rows + $1 WHERE id = $2 AND tenant_id = $3`, [
        rows.length,
        data.batchId,
        data.tenantId,
      ]);
    });
  };

  try {
    let pendingChunks: RawRow[][] = [];
    let currentChunk: RawRow[] = [];

    const flushSuperbatch = async () => {
      if (pendingChunks.length === 0) return;
      const chunks = pendingChunks;
      pendingChunks = [];
      await Promise.all(chunks.map((chunk) => processChunk(chunk)));
      processed += chunks.reduce((sum, c) => sum + c.length, 0);
      const percent = totalRows > 0 ? Math.min(Math.round((processed / totalRows) * 100), 100) : 100;
      await onProgress(percent);
    };

    for await (const row of rowSource(storage, data)) {
      currentChunk.push(row);
      if (currentChunk.length >= CHUNK_SIZE) {
        pendingChunks.push(currentChunk);
        currentChunk = [];
        if (pendingChunks.length >= CONCURRENCY) {
          await flushSuperbatch();
        }
      }
    }
    if (currentChunk.length > 0) pendingChunks.push(currentChunk);
    await flushSuperbatch();
  } catch (err) {
    // Unrecoverable error (spec Section 5.4) — e.g. a corrupt CSV mid-file.
    // Whatever rows already committed in earlier chunks stay committed
    // (partial processing); the batch itself is marked FAILED rather than
    // COMPLETED_WITH_ERRORS, which is reserved for a run that finished but
    // had per-row validation/duplicate errors.
    await withTenantContext(dataSource, data.tenantId, async (qr) => {
      await qr.manager.query(
        `UPDATE ingestion_batch SET status = $1, total_rows = $2, succeeded_rows = $3, failed_rows = $4, completed_at = now() WHERE id = $5 AND tenant_id = $6`,
        [IngestionBatchStatus.FAILED, succeeded + failed, succeeded, failed, data.batchId, data.tenantId],
      );
    });
    throw err;
  }

  let errorReportKey: string | null = null;
  if (errorRows.length > 0) {
    errorReportKey = data.storageKey ? `${data.storageKey}.errors.csv` : `tenants/${data.tenantId}/ingestion/${data.batchId}.errors.csv`;
    const csvLines = [
      "row_number,cbs_transaction_id,error_code,error_message",
      ...errorRows.map((r) => `${r.rowNumber},${r.cbsTransactionId},${r.errorCode},"${r.errorMessage.replace(/"/g, '""')}"`),
    ];
    await storage.upload(errorReportKey, Readable.from([csvLines.join("\n")]));
  }

  const finalStatus = errorRows.length === 0 ? IngestionBatchStatus.COMPLETED : IngestionBatchStatus.COMPLETED_WITH_ERRORS;
  await withTenantContext(dataSource, data.tenantId, async (qr) => {
    await qr.manager.query(
      `UPDATE ingestion_batch SET status = $1, total_rows = $2, succeeded_rows = $3, failed_rows = $4, error_report_url = $5, completed_at = now() WHERE id = $6 AND tenant_id = $7`,
      [finalStatus, succeeded + failed, succeeded, failed, errorReportKey, data.batchId, data.tenantId],
    );
  });

  return { total: succeeded + failed, succeeded, failed, errorReportKey, insertedTransactions };
}
