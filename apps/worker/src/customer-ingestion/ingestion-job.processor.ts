import { parse } from "csv-parse";
import { DataSource, QueryRunner } from "typeorm";
import { AuditLogEntity, CustomerEntity, RiskFactorConfigEntity, RiskScoreHistoryEntity } from "@regops/db";
import { IngestionJobData, IngestionJobResult, RiskFactorType, RiskLevel, ScoreTrigger } from "@regops/shared";
import { aggregateRiskScore, createFactorRegistry, RiskFactorContext, runFactors } from "@regops/risk-engine";
import type { FileStorage } from "@regops/file-storage";
import { customerCsvRowSchema, CustomerCsvRow, errorCodeForField } from "./csv-row.schema";

const BATCH_SIZE = 100;
// Each chunk is processed on its own connection/transaction; running several
// chunks concurrently multiplies throughput because the per-row cost here is
// dominated by network round trips to Postgres, not CPU or lock contention —
// see the ingestion benchmark (section 7.5), which requires 100k rows in
// under 10 minutes on a single worker process.
const CONCURRENCY = 6;

/**
 * Minimal equivalent of apps/api's AuditService.record() — same shape, same
 * "write it on the request's own connection so it's atomic with the
 * business write" principle, just without a NestJS DI container to inject
 * an AuditService into (this runs in apps/worker, a plain Node process).
 */
async function recordAudit(
  qr: QueryRunner,
  params: {
    tenantId: string;
    userId: string | null;
    action: string;
    entityType: string;
    entityId: string;
    afterState: Record<string, unknown>;
  },
): Promise<void> {
  const repo = qr.manager.getRepository(AuditLogEntity);
  await repo.save(
    repo.create({
      tenantId: params.tenantId,
      userId: params.userId,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      beforeState: null,
      afterState: params.afterState,
      ipAddress: null,
      userAgent: null,
    }),
  );
}

interface ErrorRow {
  rowNumber: number;
  cbsCustomerId: string;
  errorCode: string;
  errorMessage: string;
}

const SCORING_RELEVANT_KEYS: (keyof CustomerEntity)[] = [
  "customerType",
  "occupation",
  "country",
  "nationality",
  "kycTier",
  "isPep",
  "isSanctioned",
];

function mapRowToCustomerFields(row: CustomerCsvRow, tenantId: string) {
  return {
    tenantId,
    cbsCustomerId: row.cbs_customer_id,
    bvn: row.bvn ?? null,
    nin: row.nin ?? null,
    fullName: row.full_name,
    email: row.email ?? null,
    phone: row.phone ?? null,
    dateOfBirth: row.date_of_birth ? new Date(row.date_of_birth) : null,
    customerType: row.customer_type,
    occupation: row.occupation ?? null,
    country: row.country ?? "NG",
    nationality: row.nationality ?? null,
    kycTier: row.kyc_tier,
    onboardedAt: new Date(row.onboarded_at),
  };
}

/** Opens a dedicated connection scoped to exactly one tenant — never app.bypass_rls — same
 * pattern as RescoreSchedulerService.withTenantContext in apps/api (duplicated rather than
 * shared: it's ~15 lines and the two processes don't otherwise share a runtime). */
async function withTenantContext<T>(
  dataSource: DataSource,
  tenantId: string,
  fn: (qr: QueryRunner) => Promise<T>,
): Promise<T> {
  const qr = dataSource.createQueryRunner();
  await qr.connect();
  await qr.startTransaction();
  try {
    await qr.query(
      `SELECT set_config('app.current_tenant_id', $1, true), set_config('app.bypass_rls', 'false', true)`,
      [tenantId],
    );
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

/**
 * Pure score computation over field values only (no DB access). The score
 * never depends on the row already being persisted, so callers can fold the
 * result directly into a single INSERT/UPDATE instead of writing the row
 * first and then issuing a separate UPDATE for the computed risk fields —
 * that merge removes one round trip per row, which matters at 100k-row scale.
 */
async function computeRiskScore(
  customerId: string,
  fields: Pick<
    CustomerEntity,
    "tenantId" | "customerType" | "occupation" | "country" | "nationality" | "kycTier" | "isPep" | "isSanctioned"
  >,
  configByType: Map<RiskFactorType, RiskFactorConfigEntity>,
  now: Date,
): Promise<{ score: number; level: RiskLevel; factors: Record<string, unknown> }> {
  const results = await runFactors(createFactorRegistry(), (factor) => {
    const config = configByType.get(factor.type);
    if (!config) return null;
    const ctx: RiskFactorContext = {
      customerId,
      customer: {
        customerType: fields.customerType,
        occupation: fields.occupation,
        country: fields.country,
        nationality: fields.nationality,
        kycTier: fields.kycTier,
        isPep: fields.isPep,
        isSanctioned: fields.isSanctioned,
      },
      tenant: { id: fields.tenantId },
      config: { factorType: config.factorType, weight: config.weight, config: config.config, isActive: config.isActive },
      now,
    };
    return ctx;
  });

  return aggregateRiskScore(results, fields);
}

function scoringFieldsChanged(before: CustomerEntity, after: CustomerEntity): boolean {
  return SCORING_RELEVANT_KEYS.some((key) => before[key] !== after[key]);
}

async function countDataRows(storage: FileStorage, storageKey: string): Promise<number> {
  const stream = await storage.getReadStream(storageKey);
  let count = 0;
  for await (const chunk of stream) {
    for (const byte of chunk as Buffer) {
      if (byte === 0x0a) count += 1;
    }
  }
  // The header row doesn't count as a data row; a trailing newline (or its
  // absence) makes an exact "number of \n" count off by at most one, which
  // only matters for a progress percentage, not correctness.
  return Math.max(count - 1, 0);
}

export async function processIngestionJob(
  dataSource: DataSource,
  storage: FileStorage,
  data: IngestionJobData,
  onProgress: (percent: number) => Promise<void>,
): Promise<IngestionJobResult> {
  const configs = await withTenantContext(dataSource, data.tenantId, (qr) =>
    qr.manager.getRepository(RiskFactorConfigEntity).find({ where: { tenantId: data.tenantId, isActive: true } }),
  );
  const configByType = new Map(configs.map((c) => [c.factorType, c]));

  const totalRows = await countDataRows(storage, data.storageKey);

  const errorRows: ErrorRow[] = [];
  let succeeded = 0;
  let failed = 0;
  let processed = 0;

  const readStream = await storage.getReadStream(data.storageKey);
  const parser = readStream.pipe(
    parse({ columns: true, skip_empty_lines: true, trim: true }),
  );

  type Row = { rowNumber: number; raw: Record<string, string> };

  // succeeded/failed/errorRows are plain closures mutated from multiple
  // concurrently-running chunks below — safe because JS is single-threaded;
  // each chunk only yields the event loop at await points, so these mutations
  // never interleave mid-statement.
  const processChunk = async (rows: Row[]): Promise<void> => {
    await withTenantContext(dataSource, data.tenantId, async (qr) => {
      const customerRepo = qr.manager.getRepository(CustomerEntity);
      const riskHistoryRepo = qr.manager.getRepository(RiskScoreHistoryEntity);

      for (const { rowNumber: rn, raw } of rows) {
        const parseResult = customerCsvRowSchema.safeParse(raw);
        if (!parseResult.success) {
          const issue = parseResult.error.issues[0];
          failed += 1;
          errorRows.push({
            rowNumber: rn,
            cbsCustomerId: raw.cbs_customer_id ?? "",
            errorCode: errorCodeForField(String(issue.path[0] ?? "")),
            errorMessage: issue.message,
          });
          continue;
        }
        const row: CustomerCsvRow = parseResult.data;
        const now = new Date();

        // Each row gets its own SAVEPOINT (a nested startTransaction() — TypeORM
        // turns this into a real SAVEPOINT since the batch transaction is already
        // active). Without this, a single row's constraint violation (e.g. a
        // duplicate BVN) would abort the whole Postgres transaction, silently
        // discarding every other row already processed in this batch — the
        // per-row try/catch below can't prevent that on its own, since an
        // aborted Postgres transaction rejects all statements, including COMMIT,
        // until it's rolled back to a valid point.
        await qr.startTransaction();
        try {
          const existing = await customerRepo.findOne({
            where: { tenantId: data.tenantId, cbsCustomerId: row.cbs_customer_id },
          });

          if (existing) {
            if (data.duplicateStrategy === "skip") {
              await qr.commitTransaction();
              succeeded += 1;
              continue;
            }
            const before = { ...existing };
            Object.assign(existing, mapRowToCustomerFields(row, data.tenantId));

            let historyEntry: {
              score: number;
              level: RiskLevel;
              factors: Record<string, unknown>;
              previousScore: number;
              previousLevel: RiskLevel;
            } | null = null;
            if (scoringFieldsChanged(before, existing)) {
              const { score, level, factors } = await computeRiskScore(existing.id, existing, configByType, now);
              historyEntry = { score, level, factors, previousScore: before.riskScore, previousLevel: before.riskLevel };
              existing.riskScore = score;
              existing.riskLevel = level;
              existing.lastRiskCalculatedAt = now;
            }

            const saved = await customerRepo.save(existing);
            if (historyEntry) {
              await riskHistoryRepo.save(
                riskHistoryRepo.create({
                  tenantId: data.tenantId,
                  customerId: saved.id,
                  score: historyEntry.score,
                  level: historyEntry.level,
                  factors: historyEntry.factors,
                  trigger: ScoreTrigger.CUSTOMER_UPDATED,
                  previousScore: historyEntry.previousScore,
                  previousLevel: historyEntry.previousLevel,
                  calculatedAt: now,
                  calculatedBy: null,
                }),
              );
            }
            await recordAudit(qr, {
              tenantId: data.tenantId,
              userId: data.uploadedBy,
              action: "customer.update",
              entityType: "customer",
              entityId: saved.id,
              afterState: { ...saved, source: "csv_ingestion", jobId: data.jobId },
            });
            await qr.commitTransaction();
            succeeded += 1;
            continue;
          }

          // isPep/isSanctioned aren't part of the CSV schema — new customers
          // always start as neither; a later screening match updates these.
          const fields = { ...mapRowToCustomerFields(row, data.tenantId), isPep: false, isSanctioned: false };
          const { score, level, factors } = await computeRiskScore("", fields, configByType, now);
          const customer = await customerRepo.save(
            customerRepo.create({ ...fields, riskScore: score, riskLevel: level, lastRiskCalculatedAt: now }),
          );
          await riskHistoryRepo.save(
            riskHistoryRepo.create({
              tenantId: data.tenantId,
              customerId: customer.id,
              score,
              level,
              factors,
              trigger: ScoreTrigger.INITIAL,
              previousScore: null,
              previousLevel: null,
              calculatedAt: now,
              calculatedBy: null,
            }),
          );
          await recordAudit(qr, {
            tenantId: data.tenantId,
            userId: data.uploadedBy,
            action: "customer.create",
            entityType: "customer",
            entityId: customer.id,
            afterState: { ...customer, source: "csv_ingestion", jobId: data.jobId },
          });
          await qr.commitTransaction();
          succeeded += 1;
        } catch (err) {
          if (qr.isTransactionActive) {
            await qr.rollbackTransaction();
          }
          failed += 1;
          errorRows.push({
            rowNumber: rn,
            cbsCustomerId: row.cbs_customer_id,
            errorCode: "PROCESSING_ERROR",
            errorMessage: (err as Error).message,
          });
        }
      }
    });
  };

  let pendingChunks: Row[][] = [];
  let currentChunk: Row[] = [];
  let rowNumber = 1; // header is row 1; first data row is row 2, matching a spreadsheet's line numbers

  const flushSuperbatch = async () => {
    if (pendingChunks.length === 0) return;
    const chunks = pendingChunks;
    pendingChunks = [];
    await Promise.all(chunks.map((chunk) => processChunk(chunk)));
    processed += chunks.reduce((sum, c) => sum + c.length, 0);
    const percent = totalRows > 0 ? Math.min(Math.round((processed / totalRows) * 100), 100) : 100;
    await onProgress(percent);
  };

  for await (const raw of parser as AsyncIterable<Record<string, string>>) {
    rowNumber += 1;
    currentChunk.push({ rowNumber, raw });
    if (currentChunk.length >= BATCH_SIZE) {
      pendingChunks.push(currentChunk);
      currentChunk = [];
      if (pendingChunks.length >= CONCURRENCY) {
        await flushSuperbatch();
      }
    }
  }
  if (currentChunk.length > 0) {
    pendingChunks.push(currentChunk);
  }
  await flushSuperbatch();

  let errorReportKey: string | null = null;
  if (errorRows.length > 0) {
    errorReportKey = `${data.storageKey}.errors.csv`;
    const csvLines = [
      "row_number,cbs_customer_id,error_code,error_message",
      ...errorRows.map(
        (r) => `${r.rowNumber},${r.cbsCustomerId},${r.errorCode},"${r.errorMessage.replace(/"/g, '""')}"`,
      ),
    ];
    const { Readable } = await import("stream");
    await storage.upload(errorReportKey, Readable.from([csvLines.join("\n")]));
  }

  return { total: succeeded + failed, succeeded, failed, errorReportKey };
}
