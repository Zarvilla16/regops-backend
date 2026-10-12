import { v2 as cloudinary } from "cloudinary";
import { Readable } from "stream";
import { FileStorage } from "./file-storage.interface";

export interface CloudinaryFileStorageOptions {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  /** Optional folder prepended to every key, e.g. "regops-prod". Keeps environments apart in one account. */
  rootFolder?: string;
}

/**
 * Cloudinary-backed FileStorage. Every object is stored as resource_type "raw" with delivery type
 * "authenticated", so nothing is reachable by a plain URL — reads go through a signed URL generated
 * server-side. Same tenant-scoped key scheme as LocalFileStorage.
 *
 * getSignedDownloadUrl deliberately returns null: callers then proxy downloads through authenticated
 * API routes (the existing behaviour for local storage), so tenant/role checks always apply.
 *
 * Operational limits to know about: raw uploads are capped by the Cloudinary plan (10 MB on the free
 * plan), and list() uses the Admin API, which is rate limited (500 calls/hour on the free plan).
 */
export class CloudinaryFileStorage implements FileStorage {
  private readonly root: string;

  constructor(options: CloudinaryFileStorageOptions) {
    cloudinary.config({
      cloud_name: options.cloudName,
      api_key: options.apiKey,
      api_secret: options.apiSecret,
      secure: true,
    });
    this.root = options.rootFolder ? options.rootFolder.replace(/^\/+|\/+$/g, "") : "";
  }

  private toPublicId(key: string): string {
    if (key.startsWith("/") || key.split("/").includes("..")) {
      throw new Error(`Invalid storage key: ${key}`);
    }
    return this.root ? `${this.root}/${key}` : key;
  }

  private toKey(publicId: string): string {
    return this.root && publicId.startsWith(`${this.root}/`) ? publicId.slice(this.root.length + 1) : publicId;
  }

  async upload(key: string, stream: Readable): Promise<void> {
    const publicId = this.toPublicId(key);
    await new Promise<void>((resolve, reject) => {
      const sink = cloudinary.uploader.upload_stream(
        { public_id: publicId, resource_type: "raw", type: "authenticated", overwrite: true, invalidate: true },
        (error) => (error ? reject(error) : resolve()),
      );
      stream.on("error", reject);
      stream.pipe(sink);
    });
  }

  async getReadStream(key: string): Promise<Readable> {
    const url = cloudinary.url(this.toPublicId(key), {
      resource_type: "raw",
      type: "authenticated",
      sign_url: true,
      secure: true,
    });
    const response = await fetch(url);
    if (!response.ok || !response.body) {
      throw new Error(`Cloudinary download failed for ${key}: HTTP ${response.status}`);
    }
    return Readable.fromWeb(response.body as import("stream/web").ReadableStream);
  }

  async getSignedDownloadUrl(): Promise<string | null> {
    return null;
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let nextCursor: string | undefined;
    do {
      const page = (await cloudinary.api.resources({
        resource_type: "raw",
        type: "authenticated",
        prefix: this.toPublicId(prefix),
        max_results: 500,
        next_cursor: nextCursor,
      })) as { resources: Array<{ public_id: string }>; next_cursor?: string };
      for (const resource of page.resources) keys.push(this.toKey(resource.public_id));
      nextCursor = page.next_cursor;
    } while (nextCursor);
    return keys;
  }

  async move(fromKey: string, toKey: string): Promise<void> {
    await cloudinary.uploader.rename(this.toPublicId(fromKey), this.toPublicId(toKey), {
      resource_type: "raw",
      type: "authenticated",
      overwrite: true,
      invalidate: true,
    });
  }
}
