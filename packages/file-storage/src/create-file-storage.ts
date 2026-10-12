import * as path from "path";
import { CloudinaryFileStorage } from "./cloudinary-file-storage";
import { FileStorage } from "./file-storage.interface";
import { LocalFileStorage } from "./local-file-storage";

/**
 * Picks the storage backend from the environment so every consumer (API services, worker) resolves
 * to the SAME store. Set CLOUDINARY_URL (cloudinary://<api_key>:<api_secret>@<cloud_name>) for
 * Cloudinary; otherwise falls back to local disk (dev only — Railway services cannot share a disk,
 * and container disks don't survive redeploys). CLOUDINARY_ROOT_FOLDER optionally namespaces keys.
 */
export function createFileStorage(defaultLocalDir: string, env: NodeJS.ProcessEnv = process.env): FileStorage {
  if (env.CLOUDINARY_URL) {
    const url = new URL(env.CLOUDINARY_URL);
    if (url.protocol !== "cloudinary:" || !url.username || !url.password || !url.hostname) {
      throw new Error("CLOUDINARY_URL must look like cloudinary://<api_key>:<api_secret>@<cloud_name>");
    }
    return new CloudinaryFileStorage({
      cloudName: url.hostname,
      apiKey: decodeURIComponent(url.username),
      apiSecret: decodeURIComponent(url.password),
      rootFolder: env.CLOUDINARY_ROOT_FOLDER || undefined,
    });
  }
  if (env.NODE_ENV === "production") {
    throw new Error("CLOUDINARY_URL must be set in production — local disk storage is dev-only");
  }
  return new LocalFileStorage(path.resolve(env.LOCAL_STORAGE_DIR ?? defaultLocalDir));
}
