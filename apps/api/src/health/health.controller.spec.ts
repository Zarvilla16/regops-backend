import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";

function build(db: boolean, redis: boolean) {
  const service = {
    checkDatabase: jest.fn().mockResolvedValue({ ok: db, latencyMs: 3 }),
    checkRedis: jest.fn().mockResolvedValue({ ok: redis, latencyMs: 2 }),
  } as unknown as HealthService;
  const res = { status: jest.fn() } as any;
  return { controller: new HealthController(service), res };
}

describe("HealthController", () => {
  it("reports ok with 200 when the database and Redis answer", async () => {
    const { controller, res } = build(true, true);
    const body = await controller.check(res);
    expect(body.status).toBe("ok");
    expect(res.status).not.toHaveBeenCalled();
  });

  it("reports degraded with 503 when the database is down", async () => {
    const { controller, res } = build(false, true);
    const body = await controller.check(res);
    expect(body.status).toBe("degraded");
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("reports degraded with 503 when Redis is down", async () => {
    const { controller, res } = build(true, false);
    const body = await controller.check(res);
    expect(body.checks.redis.ok).toBe(false);
    expect(res.status).toHaveBeenCalledWith(503);
  });
});
