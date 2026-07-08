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
}
