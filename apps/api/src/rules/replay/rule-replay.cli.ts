import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../../app.module";
import { RuleReplayService } from "./rule-replay.service";

// No manual dotenv.config() here — AppModule's ConfigModule.forRoot()
// already loads .env declaratively as part of bootstrapping, same as
// apps/api/src/main.ts.

/**
 * `pnpm cli:rule-replay -- --tenant=<id> [--rule=<id>] --from=YYYY-MM-DD
 * --to=YYYY-MM-DD [--dry-run]` (Section 10.2). No nest-commander here — this
 * codebase has never depended on it (grepped clean); the closest existing
 * precedent for "run app logic outside the HTTP request cycle" is
 * packages/db/src/seed/seed.ts's plain top-level `main()` script, which this
 * mirrors, except this one needs the full apps/api Nest DI graph (Rules,
 * Alerts, Screening, Audit, Transactions), so it boots via
 * NestFactory.createApplicationContext(AppModule) instead of a standalone
 * DataSource.
 */
function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const [key, value] = raw.slice(2).split("=");
    args[key] = value ?? true;
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const tenantId = args.tenant as string | undefined;
  const from = args.from as string | undefined;
  const to = args.to as string | undefined;
  if (!tenantId || !from || !to) {
    console.error("Usage: cli:rule-replay -- --tenant=<id> [--rule=<id>] --from=YYYY-MM-DD --to=YYYY-MM-DD [--dry-run]");
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn"] });
  try {
    const replayService = app.get(RuleReplayService);
    const replayId = await replayService.replay({
      tenantId,
      ruleId: (args.rule as string | undefined) ?? null,
      from: new Date(`${from}T00:00:00Z`),
      to: new Date(`${to}T23:59:59.999Z`),
      dryRun: Boolean(args["dry-run"]),
    });
    console.log(`Rule replay started: ${replayId}`);
    console.log(`Poll GET /rules/replays/${replayId} for progress.`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error("Rule replay failed:", err);
  process.exit(1);
});
