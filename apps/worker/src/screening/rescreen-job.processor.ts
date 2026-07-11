import { DataSource, In, QueryRunner } from "typeorm";
import { CustomerEntity, TenantEntity } from "@regops/db";
import {
  CustomerStatus,
  RescreenCustomerOutcome,
  RescreenJobData,
  RescreenJobResult,
  ScreeningCheckType,
  ScreeningResultType,
  ScreeningTrigger,
} from "@regops/shared";
import { buildScreeningInputFromCustomer, runScreeningCheck } from "./screening-check-runner";
import { applyConfirmedMatchFlag } from "./apply-confirmed-match";

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
 * BullMQ processor for Section 5.3's scheduled re-screening. Never blocks —
 * a CONFIRMED_MATCH here only flags and re-scores (never deletes or blocks
 * the customer record; Section 5.3 is explicit that the MFB must act
 * through its own processes). SANCTIONS CONFIRMED_MATCH emits
 * customer.sanctions_flagged (never sanctions_confirmed — that name is
 * reserved for the manual match-review TRUE_POSITIVE path, apps/api's
 * MatchReviewService); PEP CONFIRMED_MATCH emits customer.pep_flagged, same
 * event name the async onboarding flow uses (Section 10.8 confirms this is
 * intentional — one event name regardless of which automated path found it).
 */
export async function processRescreenJob(dataSource: DataSource, data: RescreenJobData): Promise<RescreenJobResult> {
  const outcomes: RescreenCustomerOutcome[] = await withTenantContext(dataSource, data.tenantId, async (qr) => {
    const tenant = await qr.manager.getRepository(TenantEntity).findOneOrFail({ where: { id: data.tenantId } });
    const customers = await qr.manager
      .getRepository(CustomerEntity)
      .find({ where: { tenantId: data.tenantId, riskLevel: In(data.riskLevels), status: CustomerStatus.ACTIVE } });

    const results: RescreenCustomerOutcome[] = [];
    for (const customer of customers) {
      const input = buildScreeningInputFromCustomer(customer);

      for (const checkType of data.checkTypes) {
        const { check, matches } = await runScreeningCheck(qr, tenant, checkType, input, ScreeningTrigger.SCHEDULED, customer.id);

        let pepFlagged = false;
        let sanctionsFlagged = false;
        if (check.result === "CONFIRMED_MATCH") {
          if (checkType === ScreeningCheckType.PEP) {
            pepFlagged = await applyConfirmedMatchFlag(qr, customer, ScreeningCheckType.PEP, check.id);
          } else if (checkType === ScreeningCheckType.SANCTIONS) {
            sanctionsFlagged = await applyConfirmedMatchFlag(qr, customer, ScreeningCheckType.SANCTIONS, check.id);
          }
        }

        results.push({
          customerId: customer.id,
          checkType,
          checkId: check.id,
          result: check.result ?? ScreeningResultType.ERROR,
          matchIds: matches.map((m) => m.id),
          pepFlagged,
          sanctionsFlagged,
        });
      }
    }
    return results;
  });

  return { tenantId: data.tenantId, scheduleLabel: data.scheduleLabel, processed: outcomes.length, outcomes };
}
