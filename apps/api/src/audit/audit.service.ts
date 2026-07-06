import { Injectable } from "@nestjs/common";
import { QueryRunner } from "typeorm";
import { AuditLogEntity } from "@regops/db";

export interface RecordAuditParams {
  tenantId: string;
  userId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Per-entity denylist of fields that must never be persisted into
 * before_state / after_state, even though callers are expected to already
 * sanitize their DTOs before passing them in. This is the last line of
 * defense referenced by non-negotiable #2.
 */
const SENSITIVE_FIELDS: Record<string, string[]> = {
  user: ["passwordHash", "mfaSecret"],
  refresh_token: ["tokenHash"],
};
const ALWAYS_STRIP = ["passwordHash", "password", "mfaSecret", "tokenHash", "refreshToken"];

@Injectable()
export class AuditService {
  private sanitize(
    entityType: string,
    state: Record<string, unknown> | null | undefined,
  ): Record<string, unknown> | null {
    if (!state) return null;
    const denylist = new Set([...(SENSITIVE_FIELDS[entityType] ?? []), ...ALWAYS_STRIP]);
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(state)) {
      if (!denylist.has(key)) clean[key] = value;
    }
    return clean;
  }

  /**
   * Writes the audit row on the SAME connection/transaction as the business
   * write it documents, guaranteeing atomicity (non-negotiable #2). Callers
   * pass the request's QueryRunner (see CurrentQueryRunner) while their own
   * transaction is still open, and commit only after this resolves.
   *
   * A QueryRunner is required (not optional): audit_log has RLS enabled, and
   * an insert issued on the default pooled connection (via the injected
   * repository) would carry no app.current_tenant_id session var and be
   * rejected by the tenant_isolation policy. Always route through the
   * request's own tenant-stamped connection.
   */
  async record(queryRunner: QueryRunner, params: RecordAuditParams): Promise<void> {
    const repo = queryRunner.manager.getRepository(AuditLogEntity);
    await repo.save(
      repo.create({
        tenantId: params.tenantId,
        userId: params.userId,
        action: params.action,
        entityType: params.entityType,
        entityId: params.entityId,
        beforeState: this.sanitize(params.entityType, params.beforeState),
        afterState: this.sanitize(params.entityType, params.afterState),
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null,
      }),
    );
  }

  async findForTenant(
    queryRunner: QueryRunner,
    tenantId: string,
    limit = 50,
  ): Promise<AuditLogEntity[]> {
    return queryRunner.manager
      .getRepository(AuditLogEntity)
      .createQueryBuilder("audit_log")
      .where("audit_log.tenant_id = :tenantId", { tenantId })
      .orderBy("audit_log.created_at", "DESC")
      .limit(limit)
      .getMany();
  }
}
