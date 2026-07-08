import * as fs from "fs";
import * as path from "path";
import type { Readable } from "stream";
import { FileStorage } from "./file-storage.interface";

/**
 * Dev/local substitute for Cloudflare R2 — see file-storage.interface.ts.
 * Keys are tenant-scoped paths (e.g. "tenants/<id>/ingestion/<jobId>.csv");
 * resolve() rejects anything that would escape baseDir via "..".
 */
export class LocalFileStorage implements FileStorage {
  constructor(private readonly baseDir: string) {}

  private resolve(key: string): string {
    const base = path.resolve(this.baseDir);
    const target = path.resolve(base, key);
    if (target !== base && !target.startsWith(base + path.sep)) {
      throw new Error(`Invalid storage key (escapes base directory): ${key}`);
    }
    return target;
  }

  async upload(key: string, stream: Readable): Promise<void> {
    const target = this.resolve(key);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const writeStream = fs.createWriteStream(target);
      stream.on("error", reject);
      writeStream.on("error", reject);
      writeStream.on("finish", resolve);
      stream.pipe(writeStream);
    });
  }

  async getReadStream(key: string): Promise<Readable> {
    return fs.createReadStream(this.resolve(key));
  }

  async getSignedDownloadUrl(): Promise<string | null> {
    return null;
  }
}
