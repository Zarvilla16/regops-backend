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

  /** Manual recursive walk rather than fs.promises.readdir's `recursive`
   * option / Dirent.parentPath — both require a newer Node than this repo's
   * "node >= 20.0.0" engines floor guarantees. */
  private async walk(dir: string): Promise<string[]> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    const files: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await this.walk(full)));
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
    return files;
  }

  async list(prefix: string): Promise<string[]> {
    const dir = this.resolve(prefix);
    const base = path.resolve(this.baseDir);
    const absolutePaths = await this.walk(dir);
    return absolutePaths.map((absolute) => path.relative(base, absolute).split(path.sep).join("/"));
  }

  async move(fromKey: string, toKey: string): Promise<void> {
    const from = this.resolve(fromKey);
    const to = this.resolve(toKey);
    await fs.promises.mkdir(path.dirname(to), { recursive: true });
    await fs.promises.rename(from, to);
  }
}
