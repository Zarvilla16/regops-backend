import { Queue, QueueEvents } from "bullmq";
import { DataSource } from "typeorm";
import { IngestionBatchEntity, TenantEntity } from "@regops/db";
import {
  IngestionBatchStatus,
  TenantStatus,
  TransactionIngestionJobData,
  TransactionIngestionJobResult,
  TransactionSource,
} from "@regops/shared";
import type { FileStorage } from "@regops/file-storage";

const FILENAME_PATTERN = /^transactions-\d{8}-\d{3}\.csv$/;
const LOCK_TTL_MS = 5 * 60 * 1000; // spec Section 5.4: 5-minute lock TTL

/** Same defineCommand/runCommand approach as apps/api's
 * TransactionIngestionQueueService.acquireLock — see that method's docblock
 * for why bullmq's IRedisClient.set() can't express NX directly. Duplicated
 * rather than shared: no shared runtime between apps/api and apps/worker. */
async function acquireLock(queue: Queue, key: string, ttlMs: number): Promise<boolean> {
  const client = await queue.client;
  if (!(client as { regopsAcquireLock?: unknown }).regopsAcquireLock) {
    client.defineCommand("regopsAcquireLock", {
      numberOfKeys: 1,
      lua: "if redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX') then return 1 else return 0 end",
    });
  }
  const result = await client.runCommand("regopsAcquireLock", [key, "1", String(ttlMs)]);
  return result === 1;
}

/**
 * Emulated SFTP polling (spec Section 5.4) — no real SSH server exists in
 * this sandbox (see HANDOFF.md's Deviations section), so "listing a
 * tenant's inbox" is `FileStorage.list()` over a storage prefix instead of
 * an SFTP directory listing, and "moving to processed/quarantine" is
 * `FileStorage.move()` instead of an `mv` on a chroot jail. Everything
 * downstream of discovery — batch creation, enqueueing, the shared
 * processing pipeline — is identical to the webhook path.
 *
 * Runs against `dataSource` directly with no per-tenant `withTenantContext`
 * wrapper: this connects as regops_admin (BYPASSRLS at the role level, same
 * as the partition-maintenance job), and every query here already scopes by
 * tenant_id explicitly, so there's nothing an RLS session variable would add.
 */
export async function pollSftpInboxes(
  dataSource: DataSource,
  storage: FileStorage,
  queue: Queue<TransactionIngestionJobData, TransactionIngestionJobResult>,
  queueEvents: QueueEvents,
): Promise<void> {
  const tenants = await dataSource.getRepository(TenantEntity).find({ where: { status: TenantStatus.ACTIVE } });

  for (const tenant of tenants) {
    const inboxPrefix = `tenants/${tenant.id}/sftp-inbox/`;
    const files = await storage.list(inboxPrefix);

    for (const fileKey of files) {
      const filename = fileKey.slice(inboxPrefix.length);
      if (filename.includes("/")) continue; // nested path — not a direct inbox drop

      if (!FILENAME_PATTERN.test(filename)) {
        await storage.move(fileKey, `tenants/${tenant.id}/sftp-quarantine/${filename}`);
        continue;
      }

      const lockKey = `sftp-lock:${tenant.id}:${filename}`;
      const locked = await acquireLock(queue, lockKey, LOCK_TTL_MS);
      if (!locked) continue; // another worker replica already claimed this file

      const batchRepo = dataSource.getRepository(IngestionBatchEntity);
      const batch = await batchRepo.save(
        batchRepo.create({
          tenantId: tenant.id,
          source: TransactionSource.SFTP,
          sourceReference: filename,
          status: IngestionBatchStatus.QUEUED,
        }),
      );

      const jobData: TransactionIngestionJobData = {
        tenantId: tenant.id,
        batchId: batch.id,
        source: TransactionSource.SFTP,
        storageKey: fileKey,
      };

      try {
        const job = await queue.add("ingest-transactions", jobData, { jobId: batch.id });
        await job.waitUntilFinished(queueEvents);
        await storage.move(fileKey, `tenants/${tenant.id}/sftp-processed/${filename}`);
      } catch {
        // processTransactionIngestionJob already marked the batch FAILED
        // before this rejection propagated — quarantining the file is the
        // only remaining cleanup this function is responsible for.
        await storage.move(fileKey, `tenants/${tenant.id}/sftp-quarantine/${filename}`);
      }
    }
  }
}
