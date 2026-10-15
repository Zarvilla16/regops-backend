import { Controller, Get, HttpStatus, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Response } from "express";
import { HealthService } from "./health.service";

/**
 * GET /health: unauthenticated readiness probe for uptime monitors and the platform's healthcheck. Returns 200 when the
 * database and Redis both answer, 503 otherwise. Exposes component status only, never configuration or data.
 */
@ApiTags("health")
@Controller("health")
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  async check(@Res({ passthrough: true }) res: Response) {
    const [database, redis] = await Promise.all([this.health.checkDatabase(), this.health.checkRedis()]);
    const ok = database.ok && redis.ok;
    if (!ok) res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return {
      status: ok ? "ok" : "degraded",
      checks: { database, redis },
      uptimeSeconds: Math.round(process.uptime()),
      version: (process.env.RAILWAY_GIT_COMMIT_SHA ?? "").slice(0, 7) || null,
    };
  }
}
