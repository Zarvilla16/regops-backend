import "reflect-metadata";
import * as dotenv from "dotenv";
import * as path from "path";
import { DataSource } from "typeorm";
import { entities } from "@regops/db";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

/**
 * No BullMQ repeatable-job test exists anywhere in this codebase yet
 * (HANDOFF.md flags this exact gap for the audit_log partition job) — this
 * doesn't try to observe the cron schedule firing in real time either, but
 * it does verify the thing the schedule actually calls: forwarding a date
 * and confirming the resulting partition exists, idempotently, with RLS
 * already enabled on it (the bug transactions.e2e-spec.ts's RLS-at-the-
 * partition-level test caught and this migration now fixes).
 */
describe("Transaction partition maintenance (e2e)", () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = new DataSource({ type: "postgres", url: process.env.DATABASE_ADMIN_URL, entities });
    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  async function partitionExists(name: string): Promise<boolean> {
    const rows = await dataSource.query(`SELECT 1 FROM pg_class WHERE relname = $1`, [name]);
    return rows.length > 0;
  }

  async function rlsEnabled(name: string): Promise<{ enabled: boolean; forced: boolean }> {
    const rows = await dataSource.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`,
      [name],
    );
    return { enabled: rows[0]?.relrowsecurity === true, forced: rows[0]?.relforcerowsecurity === true };
  }

  it("creates a forwarded month's partition on demand, with RLS already enabled on it", async () => {
    // Far enough out that no other test/migration run is likely to have
    // pre-created it, but still deterministic per-run (not random).
    const target = new Date();
    target.setUTCMonth(target.getUTCMonth() + 14);
    const partitionName = `transaction_${target.getUTCFullYear()}_${String(target.getUTCMonth() + 1).padStart(2, "0")}`;

    await dataSource.query(`SELECT create_transaction_partition($1::date)`, [target.toISOString().slice(0, 10)]);

    expect(await partitionExists(partitionName)).toBe(true);
    const rls = await rlsEnabled(partitionName);
    expect(rls.enabled).toBe(true);
    expect(rls.forced).toBe(true);
  });

  it("is idempotent — calling it twice for the same month does not error or duplicate the partition", async () => {
    const target = new Date();
    target.setUTCMonth(target.getUTCMonth() + 15);
    const partitionName = `transaction_${target.getUTCFullYear()}_${String(target.getUTCMonth() + 1).padStart(2, "0")}`;

    await dataSource.query(`SELECT create_transaction_partition($1::date)`, [target.toISOString().slice(0, 10)]);
    await dataSource.query(`SELECT create_transaction_partition($1::date)`, [target.toISOString().slice(0, 10)]);

    const rows = await dataSource.query(`SELECT count(*)::int AS count FROM pg_class WHERE relname = $1`, [partitionName]);
    expect(rows[0].count).toBe(1);
  });
});
