import { Injectable } from "@nestjs/common";
import { QueryRunner } from "typeorm";
import { RiskFactorConfigEntity } from "@regops/db";
import { DEFAULT_RISK_FACTOR_CONFIGS } from "@regops/risk-engine";

@Injectable()
export class RiskFactorConfigService {
  async findActiveForTenant(queryRunner: QueryRunner, tenantId: string): Promise<RiskFactorConfigEntity[]> {
    return queryRunner.manager.getRepository(RiskFactorConfigEntity).find({ where: { tenantId, isActive: true } });
  }

  async findAllForTenant(queryRunner: QueryRunner, tenantId: string): Promise<RiskFactorConfigEntity[]> {
    return queryRunner.manager.getRepository(RiskFactorConfigEntity).find({ where: { tenantId } });
  }

  /** Idempotent — safe to call more than once for the same tenant (e.g. re-run seed data). */
  async seedDefaultsForTenant(queryRunner: QueryRunner, tenantId: string): Promise<void> {
    const repo = queryRunner.manager.getRepository(RiskFactorConfigEntity);
    for (const defaults of DEFAULT_RISK_FACTOR_CONFIGS) {
      const existing = await repo.findOne({ where: { tenantId, factorType: defaults.factorType } });
      if (existing) continue;
      await repo.save(
        repo.create({
          tenantId,
          factorType: defaults.factorType,
          weight: defaults.weight,
          config: defaults.config,
          isActive: true,
        }),
      );
    }
  }
}
