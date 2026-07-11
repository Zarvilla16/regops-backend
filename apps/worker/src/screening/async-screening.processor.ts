import { DataSource, QueryRunner } from "typeorm";
import { CustomerEntity, TenantEntity } from "@regops/db";
import { AsyncScreeningCheckOutcome, AsyncScreeningJobData, AsyncScreeningJobResult, ScreeningCheckType, ScreeningResultType } from "@regops/shared";
import { buildScreeningInputFromCustomer, runScreeningCheck } from "./screening-check-runner";
import { applyConfirmedMatchFlag } from "./apply-confirmed-match";

/** Opens a dedicated connection scoped to exactly one tenant — never
 * app.bypass_rls — same pattern as RescoreSchedulerService.withTenantContext
 * (apps/api) and processIngestionJob's withTenantContext (this app);
 * duplicated rather than shared across the 3 call sites for the same reason
 * documented at each of those: ~15 lines, no shared runtime to hang a
 * common helper off cleanly given how each caller wires its own DataSource. */
async function withTenantContext<T>(
  dataSource: DataSource,
  tenantId: string,
  fn: (qr: QueryRunner) => Promise<T>,
): Promise<T> {
  const qr = dataSource.createQueryRunner();
  await qr.connect();
  await qr.startTransaction();
  try {
    await qr.query(
      `SELECT set_config('app.current_tenant_id', $1, true), set_config('app.bypass_rls', 'false', true)`,
      [tenantId],
    );
    const result = await fn(qr);
    await qr.commitTransaction();
    return result;
  } catch (err) {
    if (qr.isTransactionActive) {
      await qr.rollbackTransaction();
    }
    throw err;
  } finally {
    await qr.release();
  }
}

/**
 * BullMQ processor for Section 5.2's async PEP / adverse-media flow. Always
 * dequeued after the customer row has durably committed (apps/api only
 * enqueues post-commit — see CustomersService.create()), so the customer
 * lookup here is expected to always succeed; a miss is a genuine bug
 * upstream, not a race to tolerate silently.
 */
export async function processAsyncScreeningJob(dataSource: DataSource, data: AsyncScreeningJobData): Promise<AsyncScreeningJobResult> {
  const outcomes: AsyncScreeningCheckOutcome[] = await withTenantContext(dataSource, data.tenantId, async (qr) => {
    const tenant = await qr.manager.getRepository(TenantEntity).findOneOrFail({ where: { id: data.tenantId } });
    const customer = await qr.manager.getRepository(CustomerEntity).findOneOrFail({ where: { id: data.customerId, tenantId: data.tenantId } });
    const input = buildScreeningInputFromCustomer(customer);

    const results: AsyncScreeningCheckOutcome[] = [];
    for (const checkType of data.checkTypes) {
      const { check, matches } = await runScreeningCheck(qr, tenant, checkType, input, data.trigger, customer.id);

      let pepFlagged = false;
      if (checkType === ScreeningCheckType.PEP && check.result === "CONFIRMED_MATCH") {
        pepFlagged = await applyConfirmedMatchFlag(qr, customer, ScreeningCheckType.PEP, check.id);
      }
      // ADVERSE_MEDIA: Section 5.2 — "ScreeningCheck row tracked but no
      // automatic customer flag — always goes to review." Nothing further to do.

      results.push({
        checkType,
        checkId: check.id,
        result: check.result ?? ScreeningResultType.ERROR,
        matchIds: matches.map((m) => m.id),
        pepFlagged,
      });
    }
    return results;
  });

  return { tenantId: data.tenantId, customerId: data.customerId, outcomes };
}
