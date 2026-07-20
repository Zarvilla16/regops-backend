import type { Readable } from "stream";

/**
 * Storage abstraction for CSV batch ingestion uploads and error reports.
 * The spec calls for Cloudflare R2; this sandbox has no R2 account, so
 * LocalFileStorage substitutes local disk for dev. Every caller (the
 * ingestion controller in apps/api, the ingestion job processor in
 * apps/worker) depends only on this interface, so swapping in a real R2/S3
 * implementation later is a constructor change, not a call-site change.
 */
export interface FileStorage {
  upload(key: string, stream: Readable): Promise<void>;
  getReadStream(key: string): Promise<Readable>;
  /**
   * A directly-fetchable, time-limited URL for the object — null if this
   * backend has no public endpoint of its own (e.g. local dev), in which
   * case callers should proxy the download through an authenticated API
   * route instead (see CustomerIngestionController's error-report endpoint).
   */
  getSignedDownloadUrl(key: string): Promise<string | null>;
  /**
   * Lists object keys under `prefix` (non-recursive-vs-recursive is an
   * implementation detail — callers pass a full directory-shaped prefix like
   * "tenants/<id>/sftp-inbox/" and get back every key nested under it).
   * Added for Backend Prompt 4's SFTP-emulated inbox polling — a real SFTP
   * server would list a directory over SSH; here the worker lists a
   * FileStorage prefix instead.
   */
  list(prefix: string): Promise<string[]>;
  /**
   * Renames/moves an object — used to emulate "moving a file from inbox/ to
   * processed/ or quarantine/" (spec Section 5.4) without a real filesystem
   * mv on an SSH chroot jail.
   */
  move(fromKey: string, toKey: string): Promise<void>;
}
