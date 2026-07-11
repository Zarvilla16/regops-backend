import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { QueryRunner } from "typeorm";
import { CustomerEntity } from "@regops/db";
import { AuthUserContext, CustomerDto, ScoreTrigger, ScreeningCheckType, ScreeningTrigger } from "@regops/shared";
import { AuditService } from "../audit/audit.service";
import { RiskService } from "../risk/risk.service";
import { ScreeningService } from "../screening/screening.service";
import { CreateCustomerDto } from "./dto/create-customer.dto";
import { UpdateCustomerDto } from "./dto/update-customer.dto";
import { ListCustomersDto } from "./dto/list-customers.dto";
import { CUSTOMER_EVENTS } from "./customers.events";

export interface RequestMeta {
  ipAddress: string | null;
  userAgent: string | null;
}

/** Updating any of these triggers a re-score (ScoreTrigger.CUSTOMER_UPDATED) — everything else (email, phone, fullName) does not. */
const SCORING_RELEVANT_FIELDS: (keyof UpdateCustomerDto)[] = [
  "customerType",
  "occupation",
  "country",
  "nationality",
  "kycTier",
  "isPep",
  "isSanctioned",
];

@Injectable()
export class CustomersService {
  constructor(
    private readonly riskService: RiskService,
    private readonly auditService: AuditService,
    private readonly eventEmitter: EventEmitter2,
    private readonly screeningService: ScreeningService,
  ) {}

  private maskId(value: string | null): string | null {
    if (!value) return null;
    return "*".repeat(Math.max(value.length - 4, 0)) + value.slice(-4);
  }

  toDto(customer: CustomerEntity, options: { maskPii: boolean } = { maskPii: true }): CustomerDto {
    return {
      id: customer.id,
      tenantId: customer.tenantId,
      cbsCustomerId: customer.cbsCustomerId,
      bvn: options.maskPii ? this.maskId(customer.bvn) : customer.bvn,
      nin: options.maskPii ? this.maskId(customer.nin) : customer.nin,
      fullName: customer.fullName,
      email: customer.email,
      phone: customer.phone,
      dateOfBirth: customer.dateOfBirth ? customer.dateOfBirth.toISOString().slice(0, 10) : null,
      customerType: customer.customerType,
      occupation: customer.occupation,
      country: customer.country,
      nationality: customer.nationality,
      kycTier: customer.kycTier,
      riskScore: customer.riskScore,
      riskLevel: customer.riskLevel,
      lastRiskCalculatedAt: customer.lastRiskCalculatedAt ? customer.lastRiskCalculatedAt.toISOString() : null,
      isPep: customer.isPep,
      isSanctioned: customer.isSanctioned,
      lastScreenedAt: customer.lastScreenedAt ? customer.lastScreenedAt.toISOString() : null,
      status: customer.status,
      onboardedAt: customer.onboardedAt.toISOString(),
      createdAt: customer.createdAt.toISOString(),
      updatedAt: customer.updatedAt.toISOString(),
    };
  }

  async list(queryRunner: QueryRunner, tenantId: string, query: ListCustomersDto) {
    const qb = queryRunner.manager
      .getRepository(CustomerEntity)
      .createQueryBuilder("customer")
      .where("customer.tenant_id = :tenantId", { tenantId })
      .andWhere("customer.deleted_at IS NULL");

    if (query.q) {
      // word_similarity (<%), not similarity (%): `q` is typically a single short
      // word being matched against a longer multi-word full_name, and plain
      // similarity() scores the whole strings against each other — which
      // strongly penalizes exactly the kind of short-query-vs-long-name search
      // this is for. The default word_similarity threshold (0.6) is still tuned
      // for near-complete words, not letter-transposition typos like "jhon" for
      // "John" (0.2) — verified empirically against unrelated names before
      // lowering it, so this isn't just "make the failing case pass".
      await queryRunner.query(`SET LOCAL pg_trgm.word_similarity_threshold = 0.15;`);
      qb.andWhere(
        "(:q <% customer.full_name OR customer.cbs_customer_id ILIKE :qLike OR customer.bvn LIKE :qSuffix)",
        { q: query.q, qLike: `%${query.q}%`, qSuffix: `%${query.q}` },
      );
    }
    if (query.risk_level) {
      qb.andWhere("customer.risk_level IN (:...riskLevels)", { riskLevels: query.risk_level.split(",") });
    }
    if (query.customer_type) {
      qb.andWhere("customer.customer_type IN (:...customerTypes)", {
        customerTypes: query.customer_type.split(","),
      });
    }
    if (query.status) {
      qb.andWhere("customer.status = :status", { status: query.status });
    }
    if (query.is_pep !== undefined) {
      qb.andWhere("customer.is_pep = :isPep", { isPep: query.is_pep });
    }
    if (query.is_sanctioned !== undefined) {
      qb.andWhere("customer.is_sanctioned = :isSanctioned", { isSanctioned: query.is_sanctioned });
    }
    if (query.onboarded_from) {
      qb.andWhere("customer.onboarded_at >= :onboardedFrom", { onboardedFrom: query.onboarded_from });
    }
    if (query.onboarded_to) {
      qb.andWhere("customer.onboarded_at <= :onboardedTo", { onboardedTo: query.onboarded_to });
    }

    const sortField = (query.sort ?? "onboarded_at").replace(/^-/, "");
    const sortDirection = query.sort?.startsWith("-") ? "DESC" : query.sort ? "ASC" : "DESC";
    const sortColumn = { full_name: "customer.full_name", risk_score: "customer.risk_score", onboarded_at: "customer.onboarded_at" }[
      sortField
    ]!;
    qb.orderBy(sortColumn, sortDirection);

    qb.skip((query.page - 1) * query.limit).take(query.limit);

    const [rows, total] = await qb.getManyAndCount();
    return {
      data: rows.map((r) => this.toDto(r)),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  async findOne(queryRunner: QueryRunner, tenantId: string, id: string): Promise<CustomerDto> {
    const customer = await this.findEntity(queryRunner, tenantId, id);
    return this.toDto(customer);
  }

  async findOnePii(
    queryRunner: QueryRunner,
    tenantId: string,
    id: string,
    currentUser: AuthUserContext,
    reason: string,
    meta: RequestMeta,
  ): Promise<CustomerDto> {
    const customer = await this.findEntity(queryRunner, tenantId, id);

    await this.auditService.record(queryRunner, {
      tenantId,
      userId: currentUser.sub,
      action: "customer.pii.view",
      entityType: "customer",
      entityId: customer.id,
      afterState: { reason },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return this.toDto(customer, { maskPii: false });
  }

  private async findEntity(queryRunner: QueryRunner, tenantId: string, id: string): Promise<CustomerEntity> {
    const customer = await queryRunner.manager
      .getRepository(CustomerEntity)
      .findOne({ where: { tenantId, id } });
    if (!customer) {
      throw new NotFoundException({ code: "CUSTOMER_NOT_FOUND", message: "Customer not found." });
    }
    return customer;
  }

  async create(
    queryRunner: QueryRunner,
    tenantId: string,
    dto: CreateCustomerDto,
    currentUser: AuthUserContext,
    meta: RequestMeta,
  ): Promise<CustomerDto> {
    const repo = queryRunner.manager.getRepository(CustomerEntity);

    const existingByCbsId = await repo.findOne({ where: { tenantId, cbsCustomerId: dto.cbsCustomerId } });
    if (existingByCbsId) {
      throw new ConflictException({
        code: "CUSTOMER_CBS_ID_TAKEN",
        message: "A customer with this CBS customer id already exists in this tenant.",
      });
    }
    if (dto.bvn) {
      const existingByBvn = await repo.findOne({ where: { tenantId, bvn: dto.bvn } });
      if (existingByBvn) {
        throw new ConflictException({
          code: "CUSTOMER_BVN_TAKEN",
          message: "A customer with this BVN already exists in this tenant.",
        });
      }
    }

    // Section 5.1 (Backend Prompt 3): synchronous, blocking sanctions
    // pre-screen — BEFORE the Customer row is inserted, and before this
    // method's own transaction even opens. screenSync throws 422
    // (SANCTIONS_MATCH_BLOCK) on a confirmed match or 503 (fail-closed) on a
    // provider outage; either way, no Customer row is ever written. It runs
    // on its own dedicated connection (see ScreeningService.
    // withDedicatedTenantContext) specifically so the resulting
    // screening_check audit row survives even though this whole request's
    // ambient transaction is about to be rolled back by TransactionInterceptor
    // when that exception propagates.
    const sanctionsResult = await this.screeningService.screenSync(
      tenantId,
      ScreeningCheckType.SANCTIONS,
      { fullName: dto.fullName, dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : null, bvn: dto.bvn ?? null, nin: dto.nin ?? null, country: dto.country ?? "NG", nationality: dto.nationality ?? null },
      ScreeningTrigger.ONBOARDING,
      currentUser.sub,
    );

    await queryRunner.startTransaction();
    try {
      const customer = await repo.save(
        repo.create({
          tenantId,
          cbsCustomerId: dto.cbsCustomerId,
          bvn: dto.bvn ?? null,
          nin: dto.nin ?? null,
          fullName: dto.fullName,
          email: dto.email ?? null,
          phone: dto.phone ?? null,
          dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : null,
          customerType: dto.customerType,
          occupation: dto.occupation ?? null,
          country: dto.country ?? "NG",
          nationality: dto.nationality ?? null,
          kycTier: dto.kycTier,
          onboardedAt: new Date(dto.onboardedAt),
        }),
      );

      // Attaches this customer's id to the (already-committed, elsewhere)
      // screening_check row the pre-screen above left with customer_id NULL.
      await this.screeningService.attachCustomer(queryRunner, sanctionsResult.check.id, customer.id);

      await this.riskService.calculateAndPersist(queryRunner, customer, ScoreTrigger.INITIAL, null);
      // Re-read: calculateAndPersist updated risk_score/risk_level via a raw UPDATE, which doesn't
      // reflect back onto this already-loaded `customer` instance.
      const scored = await repo.findOneOrFail({ where: { id: customer.id } });

      await this.auditService.record(queryRunner, {
        tenantId,
        userId: currentUser.sub,
        action: "customer.create",
        entityType: "customer",
        entityId: customer.id,
        afterState: { ...scored },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      await queryRunner.commitTransaction();

      this.eventEmitter.emit(CUSTOMER_EVENTS.CREATED, {
        tenantId,
        customerId: customer.id,
        cbsCustomerId: customer.cbsCustomerId,
      });

      // Section 5.2: async, non-blocking PEP + adverse-media screening — only
      // enqueued after the customer row has durably committed, so the
      // worker can never race ahead of a row that doesn't exist yet (same
      // reasoning as emitting customer.created only after commit, just
      // above).
      await this.screeningService.enqueueAsync(tenantId, customer.id, [ScreeningCheckType.PEP, ScreeningCheckType.ADVERSE_MEDIA], ScreeningTrigger.ONBOARDING);

      return this.toDto(scored);
    } catch (err) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      throw err;
    }
  }

  async update(
    queryRunner: QueryRunner,
    tenantId: string,
    id: string,
    dto: UpdateCustomerDto,
    currentUser: AuthUserContext,
    meta: RequestMeta,
  ): Promise<CustomerDto> {
    const repo = queryRunner.manager.getRepository(CustomerEntity);
    const customer = await this.findEntity(queryRunner, tenantId, id);
    const before = { ...customer };

    const changedFields = (Object.keys(dto) as (keyof UpdateCustomerDto)[]).filter(
      (key) => dto[key] !== undefined,
    );
    const scoringRelevantChanged = changedFields.some((key) => SCORING_RELEVANT_FIELDS.includes(key));

    await queryRunner.startTransaction();
    try {
      const patch: Partial<CustomerEntity> = {};
      if (dto.bvn !== undefined) patch.bvn = dto.bvn;
      if (dto.nin !== undefined) patch.nin = dto.nin;
      if (dto.fullName !== undefined) patch.fullName = dto.fullName;
      if (dto.email !== undefined) patch.email = dto.email;
      if (dto.phone !== undefined) patch.phone = dto.phone;
      if (dto.dateOfBirth !== undefined) patch.dateOfBirth = new Date(dto.dateOfBirth);
      if (dto.customerType !== undefined) patch.customerType = dto.customerType;
      if (dto.occupation !== undefined) patch.occupation = dto.occupation;
      if (dto.country !== undefined) patch.country = dto.country;
      if (dto.nationality !== undefined) patch.nationality = dto.nationality;
      if (dto.kycTier !== undefined) patch.kycTier = dto.kycTier;
      if (dto.isPep !== undefined) patch.isPep = dto.isPep;
      if (dto.isSanctioned !== undefined) patch.isSanctioned = dto.isSanctioned;
      if (dto.status !== undefined) patch.status = dto.status;

      await repo.update({ id }, patch);
      let saved = await repo.findOneOrFail({ where: { id } });

      if (scoringRelevantChanged) {
        await this.riskService.calculateAndPersist(queryRunner, saved, ScoreTrigger.CUSTOMER_UPDATED, null);
        saved = await repo.findOneOrFail({ where: { id } });
      }

      await this.auditService.record(queryRunner, {
        tenantId,
        userId: currentUser.sub,
        action: "customer.update",
        entityType: "customer",
        entityId: id,
        beforeState: { ...before },
        afterState: { ...saved },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      await queryRunner.commitTransaction();

      this.eventEmitter.emit(CUSTOMER_EVENTS.UPDATED, {
        tenantId,
        customerId: id,
        changedFields,
      });

      return this.toDto(saved);
    } catch (err) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      throw err;
    }
  }

  async softDelete(
    queryRunner: QueryRunner,
    tenantId: string,
    id: string,
    reason: string,
    currentUser: AuthUserContext,
    meta: RequestMeta,
  ): Promise<void> {
    const repo = queryRunner.manager.getRepository(CustomerEntity);
    const customer = await this.findEntity(queryRunner, tenantId, id);

    await queryRunner.startTransaction();
    try {
      const deletedAt = new Date();
      await repo.update({ id }, { deletedAt });

      await this.auditService.record(queryRunner, {
        tenantId,
        userId: currentUser.sub,
        action: "customer.delete",
        entityType: "customer",
        entityId: id,
        beforeState: { ...customer },
        afterState: { deletedAt, reason },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      await queryRunner.commitTransaction();

      this.eventEmitter.emit(CUSTOMER_EVENTS.DELETED, { tenantId, customerId: id, reason });
    } catch (err) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      throw err;
    }
  }
}
