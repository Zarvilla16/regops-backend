import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue } from "bullmq";
import { DataSource } from "typeorm";

export interface ComponentHealth {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

const CHECK_TIMEOUT_MS = 3000;

/** Same host:port:password shape the queue services use; see their docblocks for why it is repeated here. */
function parseRedisUrl(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    family: 0,
    tls: parsed.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest: null as null,
  };
}

async function timed(check: () => Promise<unknown>): Promise<ComponentHealth> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), CHECK_TIMEOUT_MS);
      }),
    ]);
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: err instanceof Error ? err.message : "failed" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Readiness checks for the dependencies the API cannot work without. No tenant data is touched. */
@Injectable()
export class HealthService implements OnModuleDestroy {
  private queue: Queue | null = null;

  constructor(
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {}

  checkDatabase(): Promise<ComponentHealth> {
    return timed(() => this.dataSource.query("SELECT 1"));
  }

  checkRedis(): Promise<ComponentHealth> {
    return timed(async () => {
      if (!this.queue) {
        const redisUrl = this.configService.get<string>("redis.url") ?? "redis://127.0.0.1:6379";
        this.queue = new Queue("regops-health", { connection: parseRedisUrl(redisUrl) });
        this.queue.on("error", () => undefined);
      }
      // Any command proves the round trip to Redis; counting a queue we never use is the cheapest one BullMQ exposes.
      await this.queue.getJobCounts();
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close().catch(() => undefined);
  }
}
