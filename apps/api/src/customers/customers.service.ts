import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import * as path from "path";
import { Readable } from "stream";
import { QueryRunner, SelectQueryBuilder } from "typeorm";
import { CustomerEntity, PepDetailsEntity } from "@regops/db";
import { FileStorage, LocalFileStorage } from "@regops/file-storage";
import {
  AuthUserContext,
  CustomerDto,
  CustomerStatus,
  CustomerType,
  ScoreTrigger,
  ScreeningCheckType,
  ScreeningTrigger,
} from "@regops/shared";
import { AuditService } from "../audit/audit.service";
import { RiskService } from "../risk/risk.service";
import { ScreeningService } from "../screening/screening.service";
import { CreateCustomerDto } from "./dto/create-customer.dto";
import { UpdateCustomerDto } from "./dto/update-customer.dto";
import { ListCustomersDto } from "./dto/list-customers.dto";
import { CUSTOMER_EVENTS } from "./customers.events";

/** photoUrl's stored extension -> content-type, both ways (upload validation, download response header). */
const PHOTO_CONTENT_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

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
  /** Same construction pattern as CustomerIngestionService's own `storage` field
   * (see that file's docblock) — no NestJS DI token for FileStorage exists in
   * this codebase; every consumer builds its own LocalFileStorage directly. */
  private readonly photoStorage: FileStorage;

  constructor(
    private readonly riskService: RiskService,
    private readonly auditService: AuditService,
    private readonly eventEmitter: EventEmitter2,
    private readonly screeningService: ScreeningService,
  ) {
    const localStorageDir = process.env.LOCAL_STORAGE_DIR ?? path.resolve(__dirname, "../../../../.local-storage");
    this.photoStorage = new LocalFileStorage(localStorageDir);
  }

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
      photoUrl: customer.photoUrl,
      onboardedAt: customer.onboardedAt.toISOString(),
      createdAt: customer.createdAt.toISOString(),
      updatedAt: customer.updatedAt.toISOString(),
    };
  }

  /** Shared by list() and exportCsv() (Section 4: "reuse existing filter
   * logic, don't duplicate it") — everything except pagination, since export
   * returns every matching row regardless of page/limit. */
  private async buildFilteredCustomerQb(
    queryRunner: QueryRunner,
    tenantId: string,
    query: ListCustomersDto,
  ): Promise<SelectQueryBuilder<CustomerEntity>> {
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

    return qb;
  }

  async list(queryRunner: QueryRunner, tenantId: string, query: ListCustomersDto) {
    const qb = await this.buildFilteredCustomerQb(queryRunner, tenantId, query);
    qb.skip((query.page - 1) * query.limit).take(query.limit);

    const [rows, total] = await qb.getManyAndCount();
    return {
      data: rows.map((r) => this.toDto(r)),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  /** Section 4: same filters as GET /customers, ignoring page/limit — export
   * returns every matching row. bvn/nin stay masked (toDto's default), same
   * as GET /customers itself — no new unmasking path via export. */
  async exportCsv(queryRunner: QueryRunner, tenantId: string, query: ListCustomersDto): Promise<string> {
    const qb = await this.buildFilteredCustomerQb(queryRunner, tenantId, query);
    const rows = await qb.getMany();
    return this.toCsv(rows.map((r) => this.toDto(r)));
  }

  private toCsv(rows: CustomerDto[]): string {
    const escape = (value: unknown): string => {
      if (value === null || value === undefined) return "";
      const s = String(value);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const columns: (keyof CustomerDto)[] = [
      "id",
      "cbsCustomerId",
      "fullName",
      "bvn",
      "nin",
      "email",
      "phone",
      "dateOfBirth",
      "customerType",
      "occupation",
      "country",
      "nationality",
      "kycTier",
      "riskScore",
      "riskLevel",
      "isPep",
      "isSanctioned",
      "status",
      "onboardedAt",
    ];
    const lines = [columns.join(",")];
    for (const row of rows) {
      lines.push(columns.map((col) => escape(row[col])).join(","));
    }
    return lines.join("\n");
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

    // Section 2 (Backend Prompt 3.5): customerType === PEP doesn't cover a PEP
    // whose customerType is otherwise INDIVIDUAL/SME/etc., so either signal
    // routes to the same PENDING_EDD_APPROVAL path. Checked here (not just via
    // CreateCustomerDto's @ValidateIf) as a defense-in-depth guard, and to
    // fail fast before spending a real screening call on a request that's
    // going to 400 anyway.
    const isPepAtCreation = dto.customerType === CustomerType.PEP || dto.isPep === true;
    if (isPepAtCreation && !dto.pepDetails) {
      throw new BadRequestException({
        code: "PEP_DETAILS_REQUIRED",
        message: "pepDetails is required when customerType is PEP or isPep is true.",
      });
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
          // Set before calculateAndPersist below, not after — the risk engine's
          // PEP/sanctioned override (Prompt 2) reads customer.isPep off this same
          // in-memory instance, so a PEP customer's *initial* score must already
          // reflect the override, not get a normal score corrected on some later re-score.
          isPep: isPepAtCreation,
          status: isPepAtCreation ? CustomerStatus.PENDING_EDD_APPROVAL : CustomerStatus.ACTIVE,
        }),
      );

      // Attaches this customer's id to the (already-committed, elsewhere)
      // screening_check row the pre-screen above left with customer_id NULL.
      await this.screeningService.attachCustomer(queryRunner, sanctionsResult.check.id, customer.id);

      if (isPepAtCreation) {
        const pep = dto.pepDetails!;
        await queryRunner.manager.getRepository(PepDetailsEntity).save(
          queryRunner.manager.getRepository(PepDetailsEntity).create({
            customerId: customer.id,
            tenantId,
            pepCategory: pep.pepCategory,
            pepPosition: pep.pepPosition,
            pepInstitution: pep.pepInstitution,
            pepCountry: pep.pepCountry,
            pepStatus: pep.pepStatus,
            pepStartDate: new Date(pep.pepStartDate),
            pepEndDate: pep.pepEndDate ? new Date(pep.pepEndDate) : null,
            isPepByAssociation: pep.isPepByAssociation ?? false,
            associatedPepName: pep.associatedPepName ?? null,
            sourceOfWealth: pep.sourceOfWealth,
            nextReviewDate: new Date(pep.nextReviewDate),
          }),
        );
      }

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

    // Section 2 (Backend Prompt 3.5): PENDING_EDD_APPROVAL is system-managed —
    // only CustomersService.create()'s PEP branch may set it (a pep_details row
    // is guaranteed to exist alongside it, which an arbitrary PATCH can't create).
    if (dto.status === CustomerStatus.PENDING_EDD_APPROVAL) {
      throw new BadRequestException({
        code: "STATUS_NOT_DIRECTLY_SETTABLE",
        message: "PENDING_EDD_APPROVAL can only be set by creating a PEP customer, not via PATCH.",
      });
    }
    // And the only way *out* of it is the dedicated approval endpoint, so the
    // resulting audit action and eddApprovedBy/eddApprovedAt population can't
    // be bypassed by a plain PATCH that happens to also change `status`.
    if (customer.status === CustomerStatus.PENDING_EDD_APPROVAL && dto.status !== undefined) {
      throw new ConflictException({
        code: "PEP_APPROVAL_REQUIRED",
        message: "This customer is pending EDD approval — use POST /customers/:id/approve-pep to change its status.",
      });
    }

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

  /** Section 2: TENANT_ADMIN or COMPLIANCE_OFFICER (role-gated at the
   * controller) transitions a PEP customer out of PENDING_EDD_APPROVAL. No
   * "different person than whoever created the customer" check — a separate
   * decision from the report maker-checker workflow, per this prompt's spec. */
  async approvePep(
    queryRunner: QueryRunner,
    tenantId: string,
    id: string,
    currentUser: AuthUserContext,
    meta: RequestMeta,
  ): Promise<CustomerDto> {
    const repo = queryRunner.manager.getRepository(CustomerEntity);
    const customer = await this.findEntity(queryRunner, tenantId, id);

    if (customer.status !== CustomerStatus.PENDING_EDD_APPROVAL) {
      throw new ConflictException({
        code: "CUSTOMER_NOT_PENDING_EDD_APPROVAL",
        message: "This customer is not pending EDD approval.",
      });
    }

    // Guaranteed to exist: only CustomersService.create()'s PEP branch ever
    // produces PENDING_EDD_APPROVAL, and it inserts this row in the same
    // transaction as the Customer row — same FK-guarantee reasoning
    // MatchReviewService uses for its own findOneOrFail calls.
    const pepRepo = queryRunner.manager.getRepository(PepDetailsEntity);
    const pepDetails = await pepRepo.findOneOrFail({ where: { customerId: id } });

    await queryRunner.startTransaction();
    try {
      const now = new Date();
      await repo.update({ id }, { status: CustomerStatus.ACTIVE });
      await pepRepo.update({ id: pepDetails.id }, { eddApprovedBy: currentUser.sub, eddApprovedAt: now });
      const saved = await repo.findOneOrFail({ where: { id } });

      await this.auditService.record(queryRunner, {
        tenantId,
        userId: currentUser.sub,
        action: "customer.pep_approved",
        entityType: "customer",
        entityId: id,
        beforeState: { status: CustomerStatus.PENDING_EDD_APPROVAL },
        afterState: { status: saved.status, eddApprovedBy: currentUser.sub, eddApprovedAt: now.toISOString() },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      await queryRunner.commitTransaction();
      return this.toDto(saved);
    } catch (err) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      throw err;
    }
  }

  /** Section 3. Content-type is restricted to common image formats and
   * inferred back from the stored key's extension on download (no separate
   * DB column for it — see CustomerDto.photoUrl's docblock). */
  async uploadPhoto(
    queryRunner: QueryRunner,
    tenantId: string,
    id: string,
    file: Express.Multer.File,
    currentUser: AuthUserContext,
    meta: RequestMeta,
  ): Promise<CustomerDto> {
    const ext = PHOTO_CONTENT_TYPES[file.mimetype];
    if (!ext) {
      throw new BadRequestException({
        code: "UNSUPPORTED_PHOTO_TYPE",
        message: `Unsupported content type '${file.mimetype}'. Allowed: ${Object.keys(PHOTO_CONTENT_TYPES).join(", ")}.`,
      });
    }

    const customer = await this.findEntity(queryRunner, tenantId, id);
    const key = `tenants/${tenantId}/customers/${id}/photo.${ext}`;

    // Uploaded to FileStorage before the DB write — if this throws, no
    // photo_url is ever persisted pointing at a file that doesn't exist.
    await this.photoStorage.upload(key, Readable.from(file.buffer));

    const repo = queryRunner.manager.getRepository(CustomerEntity);
    await queryRunner.startTransaction();
    try {
      await repo.update({ id }, { photoUrl: key });
      const saved = await repo.findOneOrFail({ where: { id } });

      await this.auditService.record(queryRunner, {
        tenantId,
        userId: currentUser.sub,
        action: "customer.photo.upload",
        entityType: "customer",
        entityId: id,
        beforeState: { photoUrl: customer.photoUrl },
        afterState: { photoUrl: key },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      await queryRunner.commitTransaction();
      return this.toDto(saved);
    } catch (err) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      throw err;
    }
  }

  /** Clears the photo_url reference. Doesn't (can't — FileStorage has no
   * delete() method, and this task deliberately doesn't extend that
   * interface) remove the underlying stored bytes; see HANDOFF.md's
   * deviations for Backend Prompt 3.5. */
  async deletePhoto(
    queryRunner: QueryRunner,
    tenantId: string,
    id: string,
    currentUser: AuthUserContext,
    meta: RequestMeta,
  ): Promise<void> {
    const customer = await this.findEntity(queryRunner, tenantId, id);
    if (!customer.photoUrl) {
      throw new NotFoundException({ code: "CUSTOMER_PHOTO_NOT_FOUND", message: "This customer has no photo to delete." });
    }

    const repo = queryRunner.manager.getRepository(CustomerEntity);
    await queryRunner.startTransaction();
    try {
      await repo.update({ id }, { photoUrl: null });

      await this.auditService.record(queryRunner, {
        tenantId,
        userId: currentUser.sub,
        action: "customer.photo.delete",
        entityType: "customer",
        entityId: id,
        beforeState: { photoUrl: customer.photoUrl },
        afterState: { photoUrl: null },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      await queryRunner.commitTransaction();
    } catch (err) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      throw err;
    }
  }

  /** Not one of Section 3's two listed endpoints, but the obvious, minimal
   * complement to POST/DELETE .../photo — without it, photoUrl (a storage
   * key, not a browsable URL) is otherwise unusable by any client, and the
   * upload/delete "round trip" this prompt's Section 5 explicitly asks for
   * has nothing to round-trip through. Same streaming-download shape as
   * CustomerIngestionController's error-report endpoint. */
  async getPhotoStream(
    queryRunner: QueryRunner,
    tenantId: string,
    id: string,
  ): Promise<{ stream: Readable; contentType: string }> {
    const customer = await this.findEntity(queryRunner, tenantId, id);
    if (!customer.photoUrl) {
      throw new NotFoundException({ code: "CUSTOMER_PHOTO_NOT_FOUND", message: "This customer has no photo." });
    }

    const stream = await this.photoStorage.getReadStream(customer.photoUrl);
    const ext = customer.photoUrl.split(".").pop();
    const contentType = Object.entries(PHOTO_CONTENT_TYPES).find(([, e]) => e === ext)?.[0] ?? "application/octet-stream";
    return { stream, contentType };
  }
}
