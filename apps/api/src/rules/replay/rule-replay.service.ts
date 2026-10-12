import { randomUUID } from "crypto";
import * as path from "path";
import { Readable } from "stream";
import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { DataSource, QueryRunner } from "typeorm";
import { CustomerEntity, RuleEntity, RuleEvaluationEntity, RuleReplayEntity, TransactionEntity } from "@regops/db";
import { createFileStorage, FileStorage } from "@regops/file-storage";
import { RuleEvaluationResultStatus, RuleReplayStatus } from "@regops/shared";
import { dispatchEvaluation, EvaluationContext } from "@regops/rules-engine";
import { EvaluatorFactsGatheringService } from "../facts/evaluator-facts-gathering.service";
import { AlertsService } from "../alerts/alerts.service";

export interface RuleReplayOptions {
  tenantId: string;
  ruleId: string | null;
  from: Date;
  to: Date;
  dryRun: boolean;
}

interface DryRunRow {
  ruleId: string;
  transactionId: string;
  wouldFire: boolean;
  evidenceSummary: string;
}

/**
 * Section 10: backfills rule evaluation against historical transactions.
 * Invoked from `pnpm cli:rule-replay` (rule-replay.cli.ts) — a plain
 * NestFactory.createApplicationContext script, since this codebase has never
 * depended on nest-commander (see HANDOFF.md's Prompt 5 deviations). Progress
 * is tracked in the `rule_replay` table (mirrors IngestionBatchEntity) so
 * GET /rules/replays/:replayId, served by the live apps/api HTTP process,
 * can observe a run happening in this separate CLI process.
 */
@Injectable()
export class RuleReplayService {
  private readonly logger = new Logger(RuleReplayService.name);
  private readonly storage: FileStorage;

  constructor(
    private readonly dataSource: DataSource,
    private readonly factsGatheringService: EvaluatorFactsGatheringService,
    private readonly alertsService: AlertsService,
  ) {
    this.storage = createFileStorage(path.resolve(__dirname, "../../../../../.local-storage"));
  }

  async replay(options: RuleReplayOptions): Promise<string> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    let replayId: string;
    try {
      await qr.query(`SELECT set_config('app.current_tenant_id', $1, true), set_config('app.bypass_rls', 'false', true)`, [
        options.tenantId,
      ]);

      // Fail fast (before creating the tracking row) if an explicit rule id was given and doesn't exist.
      if (options.ruleId) await this.requireRule(qr, options.tenantId, options.ruleId);

      const total = await qr.manager
        .getRepository(TransactionEntity)
        .createQueryBuilder("t")
        .where("t.tenant_id = :tenantId", { tenantId: options.tenantId })
        .andWhere("t.occurred_at >= :from AND t.occurred_at < :to", { from: options.from, to: options.to })
        .getCount();

      const replayRepo = qr.manager.getRepository(RuleReplayEntity);
      const replay = await replayRepo.save(
        replayRepo.create({
          tenantId: options.tenantId,
          ruleId: options.ruleId,
          fromDate: options.from,
          toDate: options.to,
          dryRun: options.dryRun,
          status: RuleReplayStatus.RUNNING,
          totalTransactions: total,
          processedTransactions: 0,
          firedCount: 0,
          startedAt: new Date(),
        }),
      );
      replayId = replay.id;
      await qr.commitTransaction();
    } catch (err) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }

    // Awaited (not fire-and-forget): the CLI (this method's only caller —
    // there is no HTTP trigger endpoint, only GET /rules/replays/:id for
    // polling) exits once this returns, so a detached background task would
    // get killed mid-run when NestFactory's application context closes.
    // Runs on a fresh connection/transaction, separate from the one that
    // created the tracking row above (which is already committed and
    // visible to a concurrently-running apps/api process's GET
    // /rules/replays/:replayId while this is still in progress).
    await this.runReplay(replayId, options);

    return replayId;
  }

  private async requireRule(qr: QueryRunner, tenantId: string, ruleId: string): Promise<RuleEntity> {
    const rule = await qr.manager.getRepository(RuleEntity).findOne({ where: { id: ruleId, tenantId } });
    if (!rule) throw new NotFoundException({ code: "RULE_NOT_FOUND", message: "Rule not found." });
    return rule;
  }

  private async runReplay(replayId: string, options: RuleReplayOptions): Promise<void> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    const dryRunRows: DryRunRow[] = [];
    let processed = 0;
    let fired = 0;

    try {
      await qr.query(`SELECT set_config('app.current_tenant_id', $1, true), set_config('app.bypass_rls', 'false', true)`, [
        options.tenantId,
      ]);

      const rules = options.ruleId
        ? [await this.requireRule(qr, options.tenantId, options.ruleId)]
        : await qr.manager.getRepository(RuleEntity).find({ where: { tenantId: options.tenantId, isActive: true } });

      const transactions = await qr.manager
        .getRepository(TransactionEntity)
        .createQueryBuilder("t")
        .where("t.tenant_id = :tenantId", { tenantId: options.tenantId })
        .andWhere("t.occurred_at >= :from AND t.occurred_at < :to", { from: options.from, to: options.to })
        .orderBy("t.occurred_at", "ASC")
        .getMany();

      const customerCache = new Map<string, CustomerEntity>();

      for (const txn of transactions) {
        let customer = customerCache.get(txn.customerId) ?? null;
        if (!customer) {
          customer = await qr.manager.getRepository(CustomerEntity).findOne({ where: { tenantId: options.tenantId, id: txn.customerId } });
          if (customer) customerCache.set(txn.customerId, customer);
        }
        if (!customer) {
          processed += 1;
          continue;
        }

        const ctx: EvaluationContext = {
          tenantId: options.tenantId,
          now: txn.occurredAt,
          transaction: {
            id: txn.id,
            customerId: txn.customerId,
            amount: txn.amount,
            currency: txn.currency,
            type: txn.type,
            channel: txn.channel,
            counterpartyAccount: txn.counterpartyAccount,
            counterpartyBank: txn.counterpartyBank,
            counterpartyName: txn.counterpartyName,
            counterpartyCustomerId: txn.counterpartyCustomerId,
            occurredAt: txn.occurredAt,
          },
          customer: {
            id: customer.id,
            fullName: customer.fullName,
            customerType: customer.customerType,
            isPep: customer.isPep,
            isSanctioned: customer.isSanctioned,
            onboardedAt: customer.onboardedAt,
          },
        };

        for (const rule of rules) {
          const startedAt = Date.now();
          try {
            const facts = await this.factsGatheringService.gather(qr, ctx, rule);
            const result = dispatchEvaluation(ctx, rule.config, facts);
            const durationMs = Date.now() - startedAt;

            if (options.dryRun) {
              dryRunRows.push({
                ruleId: rule.id,
                transactionId: txn.id,
                wouldFire: result.fired,
                evidenceSummary: result.evidence?.summary ?? "",
              });
              if (result.fired) fired += 1;
            } else {
              let alertId: string | null = null;
              if (result.fired && result.evidence) {
                const outcome = await this.alertsService.createOrIncrement(qr, {
                  tenantId: options.tenantId,
                  rule,
                  customerId: ctx.customer.id,
                  triggeringTransactionId: ctx.transaction.id,
                  severity: result.severity ?? rule.severity,
                  title: result.evidence.summary,
                  evidence: { ...result.evidence.facts, relatedTransactionIds: result.evidence.relatedTransactionIds ?? [] },
                  dedupKey: result.dedupKey ?? `${rule.scenarioType}:${ctx.customer.id}:${ctx.transaction.id}`,
                  firedAt: ctx.now,
                });
                alertId = outcome.alert.id;
                fired += 1;
              }
              await qr.manager.getRepository(RuleEvaluationEntity).save(
                qr.manager.getRepository(RuleEvaluationEntity).create({
                  id: randomUUID(),
                  tenantId: options.tenantId,
                  ruleId: rule.id,
                  transactionId: txn.id,
                  evaluatedAt: new Date(),
                  durationMs,
                  result: result.fired ? RuleEvaluationResultStatus.FIRED : RuleEvaluationResultStatus.NOT_FIRED,
                  alertId,
                  errorMessage: null,
                }),
              );
            }
          } catch (err) {
            this.logger.error(`Replay ${replayId}: rule ${rule.id} failed on transaction ${txn.id}`, err as Error);
          }
        }

        processed += 1;
        if (processed % 100 === 0) {
          await qr.manager.getRepository(RuleReplayEntity).update({ id: replayId }, { processedTransactions: processed, firedCount: fired });
        }
      }

      let reportKey: string | null = null;
      if (options.dryRun) {
        reportKey = `tenants/${options.tenantId}/rule-replays/${replayId}.csv`;
        const csv = this.toCsv(dryRunRows);
        await this.storage.upload(reportKey, Readable.from([csv]));
      }

      await qr.manager.getRepository(RuleReplayEntity).update(
        { id: replayId },
        {
          status: RuleReplayStatus.COMPLETED,
          processedTransactions: processed,
          firedCount: fired,
          reportKey,
          completedAt: new Date(),
        },
      );
      await qr.commitTransaction();
    } catch (err) {
      await qr.rollbackTransaction();
      const failQr = this.dataSource.createQueryRunner();
      await failQr.connect();
      await failQr.startTransaction();
      try {
        await failQr.query(`SELECT set_config('app.current_tenant_id', $1, true), set_config('app.bypass_rls', 'false', true)`, [
          options.tenantId,
        ]);
        await failQr.manager
          .getRepository(RuleReplayEntity)
          .update({ id: replayId }, { status: RuleReplayStatus.FAILED, errorMessage: (err as Error).message, completedAt: new Date() });
        await failQr.commitTransaction();
      } catch {
        await failQr.rollbackTransaction();
      } finally {
        await failQr.release();
      }
      throw err;
    } finally {
      await qr.release();
    }
  }

  private toCsv(rows: DryRunRow[]): string {
    const header = "rule_id,transaction_id,would_fire,evidence_summary";
    const lines = rows.map(
      (r) => `${r.ruleId},${r.transactionId},${r.wouldFire},"${r.evidenceSummary.replace(/"/g, '""')}"`,
    );
    return [header, ...lines].join("\n");
  }

  async findById(qr: QueryRunner, tenantId: string, id: string): Promise<RuleReplayEntity> {
    const replay = await qr.manager.getRepository(RuleReplayEntity).findOne({ where: { id, tenantId } });
    if (!replay) throw new NotFoundException({ code: "RULE_REPLAY_NOT_FOUND", message: "Rule replay not found." });
    return replay;
  }
}
