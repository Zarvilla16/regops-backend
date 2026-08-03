# Case Management Module (Backend Prompt 6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the real Case Management module — a five-state Case investigation lifecycle, genuine two-person maker-checker SAR escalation, alert linking, FileStorage-backed evidence, and an audit-complete timeline — against the real NestJS/TypeORM/Postgres stack, replacing the frontend mock's decorative version.

**Architecture:** One new `apps/api/src/cases` module (module/controller/service split into `cases.service.ts` for state machine + CRUD + checklist, `case-notes.service.ts`, `case-evidence.service.ts` for the FileStorage-backed upload/download, `case-timeline.service.ts` for the denormalized timeline view, and an event listener that reacts to alert status changes emitted by the existing Rules/Alerts module). Seven new tables in `packages/db` via one migration, following the exact structural conventions of `1700000050000-RulesAndAlerts.ts`. A small, deliberately additive change to the existing `AlertsService`/`rules.events.ts` (Backend Prompt 5) adds a status-change event that today doesn't exist, needed for the auto-transition-to-`UNDER_INVESTIGATION` trigger.

**Tech Stack:** NestJS 10, TypeORM, Postgres (RLS), BullMQ (not needed here — no async queue in this module), `@regops/file-storage` (`LocalFileStorage`), `@nestjs/event-emitter` (`EventEmitter2`), Jest + Supertest e2e against a real `docker-compose` Postgres.

## Global Constraints

- Every tenant-scoped query MUST run through the request's own `QueryRunner` (`@CurrentQueryRunner()`), never a pooled repository — this is the single most important invariant in the codebase (HANDOFF.md item 6). All new service code follows this.
- Any code path that opens its own `QueryRunner` and calls `set_config(...)` (the event listener in this plan does) MUST wrap the whole call in `startTransaction()`/`commitTransaction()`/`rollbackTransaction()` — `is_local = true` silently no-ops outside a transaction (HANDOFF.md item 7/bug #5).
- Every batch of DB writes belonging to one logical operation must commit atomically; where a service method does multiple related writes (e.g. create case + assignment event + case_alert + audit row), wrap them in one `startTransaction()`/`commitTransaction()` block, catching and rolling back on error — same pattern as every existing service (`CustomersService.uploadPhoto`, `AlertsService.close`).
- All seven new tables get RLS (`ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + `tenant_isolation` + `super_admin_bypass` policies), exactly matching `RulesAndAlerts1700000050000`'s pattern. No exceptions, no table opts out.
- Cross-entity references (`case.customer_id`, `case.assigned_to`, `case_alert.alert_id`, etc.) are FK-by-convention only (no `REFERENCES`) — same established choice as every table since Prompt 2 (RLS enforces tenant isolation, not referential integrity).
- Audit log entries are written via `AuditService.record(queryRunner, ...)` inside the same transaction as the business write they document — never fire-and-forget, never on a different connection.
- New storage-touching code (evidence upload/download) MUST go through the `FileStorage` interface (`packages/file-storage`), never touch disk directly — construct a `LocalFileStorage` instance the same way `CustomersService`/`CustomerIngestionService` already do (`process.env.LOCAL_STORAGE_DIR ?? path.resolve(__dirname, "../../../../.local-storage")`).
- Response envelope is `{ success: true, data }` (via the global `ResponseInterceptor`) for success and `{ success: false, error: { code, message } }` (via `AllExceptionsFilter`) for errors — controllers return plain DTOs/objects, never wrap the envelope themselves.
- Role gating is `@Roles(...)` + the global `RolesGuard`, which throws `403 FORBIDDEN_ROLE` (not `FORBIDDEN` — this is the actual, already-established error code every existing role-gated endpoint in this codebase produces; the spec's literal wording "403 FORBIDDEN" is satisfied by this existing convention, not a new bespoke code per endpoint).
- Every new endpoint sits behind `@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)` at the controller level, same as every other controller.
- No new BullMQ queue, no `apps/worker` changes — every operation in this module is synchronous and request-scoped (matches the mock: no background job touches Cases).

---

## Task 1: Shared package — enums, DTOs, and Alert event-type extension

**Files:**
- Modify: `packages/shared/src/enums.ts` (append a new "Case Management (Backend Prompt 6)" section at the end)
- Modify: `packages/shared/src/types.ts` (append Case/Report DTOs)
- Modify: `apps/api/src/rules/rules.events.ts` (add `STATUS_CHANGED` event + extend `AlertClosedEvent`)
- Test: none (pure types) — verified by `pnpm --filter @regops/shared typecheck` and `pnpm --filter api typecheck` (the latter catches any consumer type error since nothing consumes these types yet, but confirms the shared package itself compiles and is consumable)

**Interfaces:**
- Produces: `CaseStatus`, `CasePriority`, `CaseApprovalOutcome`, `ReportType`, `ReportStatus` enums; `CaseDto`, `CaseCustomerSummaryDto`, `CaseAlertSummaryDto`, `CaseNoteDto`, `CaseEvidenceDto`, `CaseChecklistItemDto`, `CaseChecklistDto`, `CaseTimelineEventDto`, `CaseReportSummaryDto`, `CaseDetailDto`, `CaseListItemDto`, `ReportDto` — all consumed by every later task.
- Produces: `ALERT_EVENTS.STATUS_CHANGED = "alert.status_changed"`, `AlertStatusChangedEvent { tenantId, alertId, customerId, previousStatus, newStatus }` — consumed by Task 9's listener. `AlertClosedEvent` gains a `previousStatus: AlertStatus` field — consumed by the same listener.

- [ ] **Step 1: Append the new enums to `packages/shared/src/enums.ts`**

Add at the end of the file:

```ts
// --- Case Management (Backend Prompt 6) -------------------------------------

export enum CaseStatus {
  OPEN = "OPEN",
  UNDER_INVESTIGATION = "UNDER_INVESTIGATION",
  PENDING_APPROVAL = "PENDING_APPROVAL",
  SAR_FILED = "SAR_FILED",
  CLOSED = "CLOSED",
}

export enum CasePriority {
  LOW = "LOW",
  MEDIUM = "MEDIUM",
  HIGH = "HIGH",
}

/** Recorded on CaseApprovalEvent.outcome — one row per approve/reject decision on a PENDING_APPROVAL case. */
export enum CaseApprovalOutcome {
  APPROVED = "APPROVED",
  REJECTED = "REJECTED",
}

/** Only SAR exists in v1 — this prompt seeds a minimal Report row; Backend Prompt 7 owns the rest. */
export enum ReportType {
  SAR = "SAR",
}

/** Draft-equivalent status this prompt creates the Report row with — Backend Prompt 7 is expected to add
 * further statuses (e.g. SUBMITTED, FILED) as it builds out the real Reports lifecycle. */
export enum ReportStatus {
  DRAFT = "DRAFT",
}
```

- [ ] **Step 2: Append the new DTOs to `packages/shared/src/types.ts`**

First add `CaseApprovalOutcome, CasePriority, CaseStatus, ReportStatus, ReportType` to the existing `from "./enums"` import block (alphabetical, matching the file's existing import ordering convention). Then append at the end of the file:

```ts
// --- Case Management (Backend Prompt 6) -------------------------------------

export interface CaseDto {
  id: string;
  tenantId: string;
  caseNumber: string;
  customerId: string;
  status: CaseStatus;
  priority: CasePriority;
  assignedTo: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  submittedBy: string | null;
  submittedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  escalationRationale: string | null;
  closedAt: string | null;
  closedBy: string | null;
  closureReason: string | null;
}

/** Same field set as CustomerDto's subset used by withCaseSummary in the mock. */
export interface CaseCustomerSummaryDto {
  id: string;
  fullName: string;
  photoUrl: string | null;
  riskLevel: RiskLevel;
  riskScore: number;
  kycTier: number;
  lastScreenedAt: string | null;
  lastRiskCalculatedAt: string | null;
  isPep: boolean;
  isSanctioned: boolean;
}

export interface CaseAlertSummaryDto {
  id: string;
  title: string;
  severity: AlertSeverity;
  status: AlertStatus;
  scenario: RuleScenarioType;
}

export interface CaseNoteDto {
  id: string;
  caseId: string;
  userId: string;
  content: string;
  createdAt: string;
}

export interface CaseEvidenceDto {
  id: string;
  caseId: string;
  fileName: string;
  fileType: string;
  fileSizeBytes: number;
  uploadedBy: string;
  createdAt: string;
}

export interface CaseChecklistItemDto {
  key: "ALERT_REVIEWED" | "NOTE_ADDED" | "TRANSACTIONS_REVIEWED" | "RISK_SCORE_CURRENT";
  label: string;
  passed: boolean;
}

export interface CaseChecklistDto {
  items: CaseChecklistItemDto[];
  complete: boolean;
}

/** `type` distinguishes timeline entries for the frontend without string-matching `text` — see
 * CaseTimelineService for the exact set of types produced (opened, reassigned, note, evidence,
 * alert_linked, transaction, submitted, approved, rejected, closed, sar_filed). */
export interface CaseTimelineEventDto {
  type: string;
  at: string;
  actor: string;
  text: string;
}

export interface CaseReportSummaryDto {
  id: string;
  status: ReportStatus;
}

export interface CaseDetailDto extends CaseDto {
  customer: CaseCustomerSummaryDto | null;
  alerts: CaseAlertSummaryDto[];
  notes: CaseNoteDto[];
  evidence: CaseEvidenceDto[];
  transactions: TransactionDto[];
  timeline: CaseTimelineEventDto[];
  checklist: CaseChecklistDto;
  report: CaseReportSummaryDto | null;
}

export interface CaseListItemDto {
  id: string;
  caseNumber: string;
  customer: CaseCustomerSummaryDto | null;
  status: CaseStatus;
  priority: CasePriority;
  assignedTo: string | null;
  alertCount: number;
  createdAt: string;
}

/** Minimal seed row — Backend Prompt 7 will extend this substantially (narrative, flagged amount,
 * submission fields, XML content). See this prompt's HANDOFF.md section for the explicit handoff note. */
export interface ReportDto {
  id: string;
  tenantId: string;
  caseId: string;
  customerId: string;
  reportType: ReportType;
  status: ReportStatus;
  generatedAt: string;
  generatedBy: string;
  createdAt: string;
  updatedAt: string;
}
```

- [ ] **Step 3: Extend `apps/api/src/rules/rules.events.ts`**

Add `STATUS_CHANGED` to `ALERT_EVENTS`:

```ts
export const ALERT_EVENTS = {
  CREATED: "alert.created",
  ESCALATED: "alert.escalated",
  CRITICAL_FIRED: "alert.critical_fired",
  CLOSED: "alert.closed",
  /** Emitted whenever an alert's status actually changes via AlertsService.assign()
   * (NEW -> ASSIGNED) — Backend Prompt 6's Case Management module subscribes to this
   * (and to CLOSED, below) to auto-transition a linked case OPEN -> UNDER_INVESTIGATION
   * the first time a linked alert moves off NEW. */
  STATUS_CHANGED: "alert.status_changed",
} as const;
```

Add the new event interface and extend the existing one:

```ts
export interface AlertStatusChangedEvent {
  tenantId: string;
  alertId: string;
  customerId: string;
  previousStatus: AlertStatus;
  newStatus: AlertStatus;
}

export interface AlertClosedEvent {
  tenantId: string;
  alertId: string;
  closedBy: string;
  closeCategory: AlertCloseCategory;
  /** Added for Backend Prompt 6's Case Management auto-transition trigger — the
   * case listener only cares about closures that moved an alert off NEW. */
  previousStatus: AlertStatus;
}
```

Update `AlertCriticalFiredEvent`'s docblock — it currently says (stale, from when this event was added in Prompt 5): "Prompt 6's Case Management subscribes to auto-open a Case." Backend Prompt 6's actual written spec never calls this out as a deviation from the frontend mock, and the mock's own inventory (`docs/cases-module-frontend-inventory.md` §3) is explicit: *"Nothing else in the app auto-opens a case... every case in the live (non-seeded) data path is created by an explicit user action."* Per the spec's own rule ("where this prompt's design differs from the mock, the difference is called out explicitly in §2 — everything else should be read as match the mock's behavior"), silence here means match the mock: no auto-open. Replace the docblock with:

```ts
/** Section 7.4: emitted specifically when an Alert's severity is CRITICAL on
 * first fire. NOTE: this event has no subscriber as of Backend Prompt 6 —
 * that module's actual written spec never asks for auto-case-creation from a
 * critical alert, and the frontend mock it's built from is explicit that
 * nothing auto-opens a case. Left unconsumed deliberately; see Backend Prompt
 * 6's HANDOFF.md deviations section. */
export interface AlertCriticalFiredEvent {
  tenantId: string;
  alertId: string;
  ruleId: string;
  customerId: string;
  scenarioType: RuleScenarioType;
}
```

- [ ] **Step 4: Verify typecheck**

Run: `pnpm --filter @regops/shared typecheck && pnpm --filter api typecheck`
Expected: both PASS (no consumer references these new types yet, so this only confirms the shared package itself compiles cleanly).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/enums.ts packages/shared/src/types.ts apps/api/src/rules/rules.events.ts
git commit -m "feat(shared): add Case/Report enums and DTOs, extend alert events for case auto-transition"
```

---

## Task 2: Database layer — seven new entities + migration

**Files:**
- Create: `packages/db/src/entities/case.entity.ts`
- Create: `packages/db/src/entities/case-alert.entity.ts`
- Create: `packages/db/src/entities/case-assignment-event.entity.ts`
- Create: `packages/db/src/entities/case-note.entity.ts`
- Create: `packages/db/src/entities/case-evidence.entity.ts`
- Create: `packages/db/src/entities/case-approval-event.entity.ts`
- Create: `packages/db/src/entities/report.entity.ts`
- Create: `packages/db/src/migrations/1700000060000-Cases.ts`
- Modify: `packages/db/src/index.ts` (export the 7 new entities)
- Modify: `packages/db/src/data-source.ts` (add 7 new entities to `entities` array + imports)
- Test: migration up/down against the real `docker-compose` Postgres

**Interfaces:**
- Consumes: `CaseStatus`, `CasePriority`, `CaseApprovalOutcome`, `ReportType`, `ReportStatus` from `@regops/shared` (Task 1).
- Produces: `CaseEntity`, `CaseAlertEntity`, `CaseAssignmentEventEntity`, `CaseNoteEntity`, `CaseEvidenceEntity`, `CaseApprovalEventEntity`, `ReportEntity` — all exported from `@regops/db`, consumed by every later task.

- [ ] **Step 1: Write `packages/db/src/entities/case.entity.ts`**

```ts
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
import { CasePriority, CaseStatus } from "@regops/shared";

/**
 * case_number's per-tenant-per-year uniqueness and customer_id/assigned_to/
 * created_by/submitted_by/approved_by/closed_by FK-by-convention are the same
 * choices as every table since Prompt 2 — RLS enforces tenant isolation, not
 * referential integrity. The unique index on (tenant_id, case_number) is
 * created directly in the migration (composite, not expressible cleanly via
 * a single-column @Index() decorator).
 */
@Entity({ name: "case" })
export class CaseEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "tenant_id", type: "uuid" })
  @Index()
  tenantId!: string;

  @Column({ name: "case_number", type: "varchar", length: 50 })
  caseNumber!: string;

  @Column({ name: "customer_id", type: "uuid" })
  @Index()
  customerId!: string;

  @Column({ type: "enum", enum: CaseStatus, enumName: "case_status_enum", default: CaseStatus.OPEN })
  status!: CaseStatus;

  @Column({ type: "enum", enum: CasePriority, enumName: "case_priority_enum" })
  priority!: CasePriority;

  @Column({ name: "assigned_to", type: "uuid", nullable: true })
  assignedTo!: string | null;

  @Column({ name: "created_by", type: "uuid" })
  createdBy!: string;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;

  @Column({ name: "submitted_by", type: "uuid", nullable: true })
  submittedBy!: string | null;

  @Column({ name: "submitted_at", type: "timestamptz", nullable: true })
  submittedAt!: Date | null;

  @Column({ name: "approved_by", type: "uuid", nullable: true })
  approvedBy!: string | null;

  @Column({ name: "approved_at", type: "timestamptz", nullable: true })
  approvedAt!: Date | null;

  @Column({ name: "escalation_rationale", type: "text", nullable: true })
  escalationRationale!: string | null;

  @Column({ name: "closed_at", type: "timestamptz", nullable: true })
  closedAt!: Date | null;

  @Column({ name: "closed_by", type: "uuid", nullable: true })
  closedBy!: string | null;

  @Column({ name: "closure_reason", type: "text", nullable: true })
  closureReason!: string | null;
}
```

- [ ] **Step 2: Write `packages/db/src/entities/case-alert.entity.ts`**

```ts
import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/**
 * Replaces the mock's `alertIds: string[]` array with a real join table.
 * The "one case per alert" rule (Section 2.3) is enforced by a PARTIAL
 * UNIQUE INDEX on alert_id ALONE (not (case_id, alert_id)) created directly
 * in the migration — TypeORM decorators can't express this, same reason
 * AlertEntity's dedup_key uniqueness lives in its own migration.
 */
@Entity({ name: "case_alert" })
export class CaseAlertEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "tenant_id", type: "uuid" })
  @Index()
  tenantId!: string;

  @Column({ name: "case_id", type: "uuid" })
  @Index()
  caseId!: string;

  @Column({ name: "alert_id", type: "uuid" })
  alertId!: string;

  @Column({ name: "linked_at", type: "timestamptz" })
  linkedAt!: Date;

  @Column({ name: "linked_by", type: "uuid" })
  linkedBy!: string;
}
```

- [ ] **Step 3: Write `packages/db/src/entities/case-assignment-event.entity.ts`**

```ts
import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/** Index 0 (inserted at case creation) is the implicit "opened" assignment,
 * skipped by CaseTimelineService — see Section 3.8. */
@Entity({ name: "case_assignment_event" })
export class CaseAssignmentEventEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "tenant_id", type: "uuid" })
  @Index()
  tenantId!: string;

  @Column({ name: "case_id", type: "uuid" })
  @Index()
  caseId!: string;

  @Column({ name: "assigned_to", type: "uuid", nullable: true })
  assignedTo!: string | null;

  @Column({ name: "assigned_by", type: "uuid" })
  assignedBy!: string;

  @Column({ type: "timestamptz" })
  at!: Date;
}
```

- [ ] **Step 4: Write `packages/db/src/entities/case-note.entity.ts`**

```ts
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Entity({ name: "case_note" })
export class CaseNoteEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "tenant_id", type: "uuid" })
  @Index()
  tenantId!: string;

  @Column({ name: "case_id", type: "uuid" })
  @Index()
  caseId!: string;

  @Column({ name: "user_id", type: "uuid" })
  userId!: string;

  @Column({ type: "text" })
  content!: string;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
```

- [ ] **Step 5: Write `packages/db/src/entities/case-evidence.entity.ts`**

```ts
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/** file_key is the FileStorage key (Section 2.5), not a browsable URL — same
 * "proxy through an authenticated API route" convention as Customer.photoUrl. */
@Entity({ name: "case_evidence" })
export class CaseEvidenceEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "tenant_id", type: "uuid" })
  @Index()
  tenantId!: string;

  @Column({ name: "case_id", type: "uuid" })
  @Index()
  caseId!: string;

  @Column({ name: "file_name", type: "text" })
  fileName!: string;

  @Column({ name: "file_key", type: "text" })
  fileKey!: string;

  @Column({ name: "file_type", type: "varchar", length: 255 })
  fileType!: string;

  @Column({ name: "file_size_bytes", type: "integer" })
  fileSizeBytes!: number;

  @Column({ name: "uploaded_by", type: "uuid" })
  uploadedBy!: string;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
```

- [ ] **Step 6: Write `packages/db/src/entities/case-approval-event.entity.ts`**

```ts
import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";
import { CaseApprovalOutcome } from "@regops/shared";

@Entity({ name: "case_approval_event" })
export class CaseApprovalEventEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "tenant_id", type: "uuid" })
  @Index()
  tenantId!: string;

  @Column({ name: "case_id", type: "uuid" })
  @Index()
  caseId!: string;

  @Column({ type: "enum", enum: CaseApprovalOutcome, enumName: "case_approval_outcome_enum" })
  outcome!: CaseApprovalOutcome;

  @Column({ type: "uuid" })
  actor!: string;

  @Column({ type: "text", nullable: true })
  reason!: string | null;

  @Column({ type: "timestamptz" })
  at!: Date;
}
```

- [ ] **Step 7: Write `packages/db/src/entities/report.entity.ts`**

```ts
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
import { ReportStatus, ReportType } from "@regops/shared";

/**
 * Deliberately thin seed entity (Section 2.4/6) — auto-created the moment a
 * Case is approved into SAR_FILED. Backend Prompt 7 owns the real Reports
 * module and is expected to extend this substantially (narrative, flagged
 * amount, submission fields, XML content); do not add those fields here.
 * case_id is unique — one report per case.
 */
@Entity({ name: "report" })
export class ReportEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "tenant_id", type: "uuid" })
  @Index()
  tenantId!: string;

  @Column({ name: "case_id", type: "uuid" })
  caseId!: string;

  @Column({ name: "customer_id", type: "uuid" })
  customerId!: string;

  @Column({ name: "report_type", type: "enum", enum: ReportType, enumName: "report_type_enum" })
  reportType!: ReportType;

  @Column({ type: "enum", enum: ReportStatus, enumName: "report_status_enum", default: ReportStatus.DRAFT })
  status!: ReportStatus;

  @Column({ name: "generated_at", type: "timestamptz" })
  generatedAt!: Date;

  @Column({ name: "generated_by", type: "uuid" })
  generatedBy!: string;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
```

- [ ] **Step 8: Write the migration `packages/db/src/migrations/1700000060000-Cases.ts`**

```ts
import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Backend Prompt 6: case, case_alert, case_assignment_event, case_note,
 * case_evidence, case_approval_event, report. All plain (low volume — case
 * volume is an order of magnitude below alert volume), same RLS
 * enable/force + policy pattern as every migration since Prompt 1.
 *
 * customer_id/assigned_to/created_by/submitted_by/approved_by/closed_by/
 * alert_id/user_id/uploaded_by/actor/generated_by are all FK-by-convention
 * only (no REFERENCES) — same choice made throughout Prompts 2-5.
 */
export class Cases1700000060000 implements MigrationInterface {
  name = "Cases1700000060000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE case_status_enum AS ENUM ('OPEN', 'UNDER_INVESTIGATION', 'PENDING_APPROVAL', 'SAR_FILED', 'CLOSED');
    `);
    await queryRunner.query(`
      CREATE TYPE case_priority_enum AS ENUM ('LOW', 'MEDIUM', 'HIGH');
    `);
    await queryRunner.query(`
      CREATE TYPE case_approval_outcome_enum AS ENUM ('APPROVED', 'REJECTED');
    `);
    await queryRunner.query(`
      CREATE TYPE report_type_enum AS ENUM ('SAR');
    `);
    await queryRunner.query(`
      CREATE TYPE report_status_enum AS ENUM ('DRAFT');
    `);

    // --- case ------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "case" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        case_number varchar(50) NOT NULL,
        customer_id uuid NOT NULL,
        status case_status_enum NOT NULL DEFAULT 'OPEN',
        priority case_priority_enum NOT NULL,
        assigned_to uuid,
        created_by uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        submitted_by uuid,
        submitted_at timestamptz,
        approved_by uuid,
        approved_at timestamptz,
        escalation_rationale text,
        closed_at timestamptz,
        closed_by uuid,
        closure_reason text
      );
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_case_tenant_case_number ON "case" (tenant_id, case_number);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_case_tenant_status ON "case" (tenant_id, status);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_case_tenant_customer ON "case" (tenant_id, customer_id);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_case_tenant_assigned_to ON "case" (tenant_id, assigned_to);
    `);

    // --- case_alert ---------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE case_alert (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        case_id uuid NOT NULL,
        alert_id uuid NOT NULL,
        linked_at timestamptz NOT NULL,
        linked_by uuid NOT NULL
      );
    `);
    // Section 2.3: an alert belongs to at most one case, ever — enforced at the DB
    // level via a unique index on alert_id ALONE, not (case_id, alert_id).
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_case_alert_alert_id ON case_alert (alert_id);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_case_alert_tenant_case ON case_alert (tenant_id, case_id);
    `);

    // --- case_assignment_event ------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE case_assignment_event (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        case_id uuid NOT NULL,
        assigned_to uuid,
        assigned_by uuid NOT NULL,
        at timestamptz NOT NULL
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_case_assignment_event_tenant_case ON case_assignment_event (tenant_id, case_id);
    `);

    // --- case_note ------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE case_note (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        case_id uuid NOT NULL,
        user_id uuid NOT NULL,
        content text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_case_note_tenant_case ON case_note (tenant_id, case_id);
    `);

    // --- case_evidence ------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE case_evidence (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        case_id uuid NOT NULL,
        file_name text NOT NULL,
        file_key text NOT NULL,
        file_type varchar(255) NOT NULL,
        file_size_bytes integer NOT NULL,
        uploaded_by uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_case_evidence_tenant_case ON case_evidence (tenant_id, case_id);
    `);

    // --- case_approval_event --------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE case_approval_event (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        case_id uuid NOT NULL,
        outcome case_approval_outcome_enum NOT NULL,
        actor uuid NOT NULL,
        reason text,
        at timestamptz NOT NULL
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_case_approval_event_tenant_case ON case_approval_event (tenant_id, case_id);
    `);

    // --- report (minimal seed — Backend Prompt 7 extends this) ----------------------
    await queryRunner.query(`
      CREATE TABLE report (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        case_id uuid NOT NULL,
        customer_id uuid NOT NULL,
        report_type report_type_enum NOT NULL,
        status report_status_enum NOT NULL DEFAULT 'DRAFT',
        generated_at timestamptz NOT NULL,
        generated_by uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_report_case_id ON report (case_id);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_report_tenant ON report (tenant_id);
    `);

    // --- RLS ------------------------------------------------------------------------
    const tables = ["case", "case_alert", "case_assignment_event", "case_note", "case_evidence", "case_approval_event", "report"];
    for (const table of tables) {
      const quoted = table === "case" ? `"case"` : table;
      await queryRunner.query(`ALTER TABLE ${quoted} ENABLE ROW LEVEL SECURITY;`);
      await queryRunner.query(`ALTER TABLE ${quoted} FORCE ROW LEVEL SECURITY;`);
      await queryRunner.query(`
        CREATE POLICY tenant_isolation ON ${quoted}
          USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
      `);
      await queryRunner.query(`
        CREATE POLICY super_admin_bypass ON ${quoted}
          USING (current_setting('app.bypass_rls', true) = 'true');
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const tables = ["report", "case_approval_event", "case_evidence", "case_note", "case_assignment_event", "case_alert", "case"];
    for (const table of tables) {
      const quoted = table === "case" ? `"case"` : table;
      await queryRunner.query(`DROP POLICY IF EXISTS super_admin_bypass ON ${quoted};`);
      await queryRunner.query(`DROP POLICY IF EXISTS tenant_isolation ON ${quoted};`);
      await queryRunner.query(`ALTER TABLE ${quoted} NO FORCE ROW LEVEL SECURITY;`);
      await queryRunner.query(`ALTER TABLE ${quoted} DISABLE ROW LEVEL SECURITY;`);
    }

    await queryRunner.query(`DROP TABLE IF EXISTS report;`);
    await queryRunner.query(`DROP TABLE IF EXISTS case_approval_event;`);
    await queryRunner.query(`DROP TABLE IF EXISTS case_evidence;`);
    await queryRunner.query(`DROP TABLE IF EXISTS case_note;`);
    await queryRunner.query(`DROP TABLE IF EXISTS case_assignment_event;`);
    await queryRunner.query(`DROP TABLE IF EXISTS case_alert;`);
    await queryRunner.query(`DROP TABLE IF EXISTS "case";`);

    await queryRunner.query(`DROP TYPE IF EXISTS report_status_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS report_type_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS case_approval_outcome_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS case_priority_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS case_status_enum;`);
  }
}
```

Note: `case` is a reserved SQL keyword — every raw-SQL reference to the table is double-quoted (`"case"`), matching how the entity itself is declared (`@Entity({ name: "case" })`); TypeORM's own query builder handles this quoting automatically, only the migration's raw `queryRunner.query()` calls need it explicit.

- [ ] **Step 9: Wire the new entities into `packages/db/src/index.ts`**

Append after the existing `rule-replay.entity` export:

```ts
export * from "./entities/case.entity";
export * from "./entities/case-alert.entity";
export * from "./entities/case-assignment-event.entity";
export * from "./entities/case-note.entity";
export * from "./entities/case-evidence.entity";
export * from "./entities/case-approval-event.entity";
export * from "./entities/report.entity";
```

- [ ] **Step 10: Wire the new entities into `packages/db/src/data-source.ts`**

Add the 7 new imports after the existing `RuleReplayEntity` import, and add the 7 classes to the `entities` array after `RuleReplayEntity`:

```ts
import { CaseEntity } from "./entities/case.entity";
import { CaseAlertEntity } from "./entities/case-alert.entity";
import { CaseAssignmentEventEntity } from "./entities/case-assignment-event.entity";
import { CaseNoteEntity } from "./entities/case-note.entity";
import { CaseEvidenceEntity } from "./entities/case-evidence.entity";
import { CaseApprovalEventEntity } from "./entities/case-approval-event.entity";
import { ReportEntity } from "./entities/report.entity";
```

```ts
export const entities = [
  // ...existing entities...
  RuleReplayEntity,
  CaseEntity,
  CaseAlertEntity,
  CaseAssignmentEventEntity,
  CaseNoteEntity,
  CaseEvidenceEntity,
  CaseApprovalEventEntity,
  ReportEntity,
];
```

- [ ] **Step 11: Build and run the migration up, then down, against the real Postgres**

Run: `pnpm build --filter @regops/db && pnpm db:migrate`
Expected: migration `Cases1700000060000` applies with no errors; connect via `psql` (or a quick script) and confirm all 7 tables exist with RLS enabled (`\d+ "case"` shows `Policies` and row security enabled).

Run: `node ./node_modules/typeorm/cli.js -d packages/db/dist/data-source.js migration:revert` (from repo root, or the equivalent `pnpm --filter @regops/db` script if one exists for revert)
Expected: all 7 tables and 5 enum types are dropped cleanly with no errors; re-run `pnpm db:migrate` afterward to leave the database in the applied state for later tasks.

- [ ] **Step 12: Commit**

```bash
git add packages/db/src/entities packages/db/src/migrations packages/db/src/index.ts packages/db/src/data-source.ts
git commit -m "feat(db): add Case Management schema (case, case_alert, case_note, case_evidence, case_approval_event, case_assignment_event, report)"
```

---

## Task 3: Cases module scaffold — creation + list/detail (read side)

**Files:**
- Create: `apps/api/src/cases/cases.module.ts`
- Create: `apps/api/src/cases/cases.service.ts`
- Create: `apps/api/src/cases/cases.controller.ts`
- Create: `apps/api/src/cases/dto/create-case.dto.ts`
- Create: `apps/api/src/cases/dto/list-cases.dto.ts`
- Modify: `apps/api/src/app.module.ts` (import `CasesModule`)
- Modify: `apps/api/test/utils/test-app.ts` (add the 7 new entities to `adminDataSource`'s entities list/imports)
- Create: `apps/api/test/cases.e2e-spec.ts`

**Interfaces:**
- Consumes: `CaseEntity`, `CaseAlertEntity`, `CaseAssignmentEventEntity` (Task 2); `CaseDto`, `CaseDetailDto`, `CaseListItemDto`, `CaseCustomerSummaryDto`, `CaseAlertSummaryDto`, `CaseStatus`, `CasePriority` (Task 1); `AlertEntity`, `CustomerEntity` (existing).
- Produces: `CasesService.create()`, `CasesService.findEntity()`, `CasesService.toDetail()`, `CasesService.list()`, `CasesService.toDto()`, `CasesService.toCustomerSummary()` — all consumed and extended by Tasks 4-11. `toDetail()`'s returned object has `notes: []`, `evidence: []`, `transactions: []`, `timeline: []`, `checklist: { items: [], complete: false }` as its *current, correct-for-this-task* values (no other subsystem exists yet to populate them) — Tasks 4/5/6/7/11 each replace exactly one of those five lines with a real computation. This is not a placeholder in the "TODO" sense: at the end of this task the code is complete and correct for everything built so far.

- [ ] **Step 1: Write `apps/api/src/cases/dto/create-case.dto.ts`**

```ts
import { IsEnum, IsOptional, IsUUID } from "class-validator";
import { CasePriority } from "@regops/shared";

/** Section 3.1: customerId and alertId are both optional at the type level —
 * CasesService.create() enforces that at least one resolves to a customer
 * (400 CUSTOMER_REQUIRED otherwise), which can't be expressed as a single
 * class-validator decorator without a custom validator, so it's a service-
 * level check instead (matches the spec's own field-resolution ordering). */
export class CreateCaseDto {
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsUUID()
  alertId?: string;

  @IsOptional()
  @IsEnum(CasePriority)
  priority?: CasePriority;
}
```

- [ ] **Step 2: Write `apps/api/src/cases/dto/list-cases.dto.ts`**

```ts
import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Min } from "class-validator";

/** Comma-separated enum lists come through as plain strings and are split/
 * validated in the controller — same convention as ListAlertsDto. */
export class ListCasesDto {
  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  priority?: string;

  @IsOptional()
  @IsString()
  assigned_to?: string;

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 25;
}
```

- [ ] **Step 3: Write `apps/api/src/cases/cases.service.ts`**

```ts
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { QueryRunner } from "typeorm";
import { AlertEntity, CaseAlertEntity, CaseAssignmentEventEntity, CaseEntity, CustomerEntity } from "@regops/db";
import {
  AlertSeverity,
  AuthUserContext,
  CaseCustomerSummaryDto,
  CaseDetailDto,
  CaseDto,
  CaseListItemDto,
  CasePriority,
  CaseStatus,
} from "@regops/shared";
import { AuditService } from "../audit/audit.service";
import { RequestMeta } from "../users/users.service";
import { CreateCaseDto } from "./dto/create-case.dto";

export interface CaseFilters {
  statuses?: CaseStatus[];
  priorities?: CasePriority[];
  assignedTo?: string;
  q?: string;
}

@Injectable()
export class CasesService {
  constructor(private readonly auditService: AuditService) {}

  /** Section 3.1: `CASE-<year>-####`, sequence = (max existing sequence for
   * this tenant+year) + 1 — recomputed per call, not a stored counter row
   * (matches the mock's nextCaseNumber exactly, per the spec's explicit
   * instruction not to introduce a counter table). Callers MUST invoke this
   * inside the request's already-open transaction; under concurrent case
   * creation for the same tenant+year this can race to a duplicate suffix,
   * which the (tenant_id, case_number) unique index would then reject as a
   * 500 — an accepted, documented limitation carried over from the mock's
   * own non-atomic approach, not something this prompt was asked to fix. */
  private async nextCaseNumber(qr: QueryRunner, tenantId: string): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `CASE-${year}-`;
    const rows: { case_number: string }[] = await qr.manager.query(
      `SELECT case_number FROM "case" WHERE tenant_id = $1 AND case_number LIKE $2 ORDER BY case_number DESC LIMIT 1`,
      [tenantId, `${prefix}%`],
    );
    const lastSeq = rows.length > 0 ? parseInt(rows[0].case_number.slice(prefix.length), 10) : 0;
    return `${prefix}${String(lastSeq + 1).padStart(4, "0")}`;
  }

  /** Section 3.1: three entry points, one path. alertId's customerId always
   * wins over any customerId also present in the body. */
  async create(qr: QueryRunner, tenantId: string, dto: CreateCaseDto, currentUser: AuthUserContext, meta: RequestMeta): Promise<CaseDetailDto> {
    let alert: AlertEntity | null = null;
    let customerId = dto.customerId ?? null;

    if (dto.alertId) {
      alert = await qr.manager.getRepository(AlertEntity).findOne({ where: { id: dto.alertId, tenantId } });
      if (!alert) throw new NotFoundException({ code: "ALERT_NOT_FOUND", message: "Alert not found." });
      customerId = alert.customerId;
    }

    if (!customerId) {
      throw new BadRequestException({ code: "CUSTOMER_REQUIRED", message: "A customerId or alertId is required." });
    }

    const customer = await qr.manager.getRepository(CustomerEntity).findOne({ where: { id: customerId, tenantId } });
    if (!customer) throw new NotFoundException({ code: "CUSTOMER_NOT_FOUND", message: "Customer not found." });

    let priority = dto.priority;
    if (!priority) {
      if (alert) {
        priority = alert.severity === AlertSeverity.CRITICAL || alert.severity === AlertSeverity.HIGH ? CasePriority.HIGH : CasePriority.MEDIUM;
      } else {
        priority = CasePriority.MEDIUM;
      }
    }

    await qr.startTransaction();
    try {
      const caseNumber = await this.nextCaseNumber(qr, tenantId);
      // Computed once and reused for created_at/the assignment event's at/the
      // case_alert's linked_at (below) — NOT left to @CreateDateColumn's own
      // DB-side now() default. Task 11's timeline needs to tell "linked at
      // creation" apart from "linked later" by exact timestamp equality
      // (linked_at === case.created_at); Postgres's now() returns
      // transaction-START time while a JS `new Date()` called moments later
      // inside that same transaction is always >= it, so relying on the
      // column default here would make every creation-time link look "later
      // than creation" and wrongly get its own "Alert linked" timeline entry
      // in addition to being counted in the "Opened" event's alert count.
      const now = new Date();
      const caseRepo = qr.manager.getRepository(CaseEntity);
      const kase = await caseRepo.save(
        caseRepo.create({
          tenantId,
          caseNumber,
          customerId,
          status: CaseStatus.OPEN,
          priority,
          assignedTo: currentUser.sub,
          createdBy: currentUser.sub,
          createdAt: now,
        }),
      );

      const assignmentRepo = qr.manager.getRepository(CaseAssignmentEventEntity);
      await assignmentRepo.save(
        assignmentRepo.create({ tenantId, caseId: kase.id, assignedTo: currentUser.sub, assignedBy: currentUser.sub, at: now }),
      );

      if (alert) {
        const caseAlertRepo = qr.manager.getRepository(CaseAlertEntity);
        await caseAlertRepo.save(
          caseAlertRepo.create({ tenantId, caseId: kase.id, alertId: alert.id, linkedAt: now, linkedBy: currentUser.sub }),
        );
      }

      await this.auditService.record(qr, {
        tenantId,
        userId: currentUser.sub,
        action: "case.opened",
        entityType: "case",
        entityId: kase.id,
        beforeState: null,
        afterState: { caseNumber, status: kase.status, customerId, alertIds: alert ? [alert.id] : [] },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      await qr.commitTransaction();
      return this.toDetail(qr, tenantId, kase.id);
    } catch (err) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw err;
    }
  }

  async findEntity(qr: QueryRunner, tenantId: string, id: string): Promise<CaseEntity> {
    const kase = await qr.manager.getRepository(CaseEntity).findOne({ where: { id, tenantId } });
    if (!kase) throw new NotFoundException({ code: "CASE_NOT_FOUND", message: "Case not found." });
    return kase;
  }

  async linkedAlerts(qr: QueryRunner, tenantId: string, caseId: string): Promise<AlertEntity[]> {
    const links = await qr.manager.getRepository(CaseAlertEntity).find({ where: { tenantId, caseId } });
    if (links.length === 0) return [];
    const alertIds = links.map((l) => l.alertId);
    return qr.manager
      .getRepository(AlertEntity)
      .createQueryBuilder("a")
      .where("a.tenant_id = :tenantId", { tenantId })
      .andWhere("a.id IN (:...alertIds)", { alertIds })
      .getMany();
  }

  toCustomerSummary(customer: CustomerEntity): CaseCustomerSummaryDto {
    return {
      id: customer.id,
      fullName: customer.fullName,
      photoUrl: customer.photoUrl,
      riskLevel: customer.riskLevel,
      riskScore: customer.riskScore,
      kycTier: customer.kycTier,
      lastScreenedAt: customer.lastScreenedAt ? customer.lastScreenedAt.toISOString() : null,
      lastRiskCalculatedAt: customer.lastRiskCalculatedAt ? customer.lastRiskCalculatedAt.toISOString() : null,
      isPep: customer.isPep,
      isSanctioned: customer.isSanctioned,
    };
  }

  toDto(kase: CaseEntity): CaseDto {
    return {
      id: kase.id,
      tenantId: kase.tenantId,
      caseNumber: kase.caseNumber,
      customerId: kase.customerId,
      status: kase.status,
      priority: kase.priority,
      assignedTo: kase.assignedTo,
      createdBy: kase.createdBy,
      createdAt: kase.createdAt.toISOString(),
      updatedAt: kase.updatedAt.toISOString(),
      submittedBy: kase.submittedBy,
      submittedAt: kase.submittedAt ? kase.submittedAt.toISOString() : null,
      approvedBy: kase.approvedBy,
      approvedAt: kase.approvedAt ? kase.approvedAt.toISOString() : null,
      escalationRationale: kase.escalationRationale,
      closedAt: kase.closedAt ? kase.closedAt.toISOString() : null,
      closedBy: kase.closedBy,
      closureReason: kase.closureReason,
    };
  }

  /** Section 3.7. notes/evidence/transactions/timeline/checklist are filled
   * in by Tasks 4/5/6(+11 for transactions' final consumer, the checklist)/
   * 11 respectively — each replaces exactly one of the five lines below with
   * a real call, nothing else in this method changes. */
  async toDetail(qr: QueryRunner, tenantId: string, id: string): Promise<CaseDetailDto> {
    const kase = await this.findEntity(qr, tenantId, id);
    const customer = await qr.manager.getRepository(CustomerEntity).findOne({ where: { id: kase.customerId, tenantId } });
    const alerts = await this.linkedAlerts(qr, tenantId, id);

    return {
      ...this.toDto(kase),
      customer: customer ? this.toCustomerSummary(customer) : null,
      alerts: alerts.map((a) => ({ id: a.id, title: a.title, severity: a.severity, status: a.status, scenario: a.scenarioType })),
      notes: [],
      evidence: [],
      transactions: [],
      timeline: [],
      checklist: { items: [], complete: false },
      report: null,
    };
  }

  /** Section 4.3. Low case volume (same order of magnitude as Alert/Rule
   * rows, not Transaction rows) makes the per-row customer-summary lookup
   * below acceptable without a batched join — same judgment call as
   * AlertsService.findAll not batching either. */
  async list(
    qr: QueryRunner,
    tenantId: string,
    filters: CaseFilters,
    page: number,
    limit: number,
  ): Promise<{ data: CaseListItemDto[]; meta: { page: number; limit: number; total: number } }> {
    const qb = qr.manager.getRepository(CaseEntity).createQueryBuilder("c").where("c.tenant_id = :tenantId", { tenantId });

    if (filters.statuses?.length) qb.andWhere("c.status IN (:...statuses)", { statuses: filters.statuses });
    if (filters.priorities?.length) qb.andWhere("c.priority IN (:...priorities)", { priorities: filters.priorities });
    if (filters.assignedTo === "unassigned") {
      qb.andWhere("c.assigned_to IS NULL");
    } else if (filters.assignedTo) {
      qb.andWhere("c.assigned_to = :assignedTo", { assignedTo: filters.assignedTo });
    }
    if (filters.q) {
      qb.leftJoin(CustomerEntity, "cust", "cust.id = c.customer_id AND cust.tenant_id = c.tenant_id");
      qb.andWhere("(c.case_number ILIKE :q OR cust.full_name ILIKE :q)", { q: `%${filters.q}%` });
    }

    qb.orderBy("c.created_at", "DESC");
    qb.skip((page - 1) * limit).take(limit);

    const [rows, total] = await qb.getManyAndCount();
    const data = await Promise.all(rows.map((r) => this.toListItem(qr, tenantId, r)));
    return { data, meta: { page, limit, total } };
  }

  private async toListItem(qr: QueryRunner, tenantId: string, kase: CaseEntity): Promise<CaseListItemDto> {
    const customer = await qr.manager.getRepository(CustomerEntity).findOne({ where: { id: kase.customerId, tenantId } });
    const alertCount = await qr.manager.getRepository(CaseAlertEntity).count({ where: { tenantId, caseId: kase.id } });
    return {
      id: kase.id,
      caseNumber: kase.caseNumber,
      customer: customer ? this.toCustomerSummary(customer) : null,
      status: kase.status,
      priority: kase.priority,
      assignedTo: kase.assignedTo,
      alertCount,
      createdAt: kase.createdAt.toISOString(),
    };
  }
}
```

- [ ] **Step 4: Write `apps/api/src/cases/cases.controller.ts`**

```ts
import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Request } from "express";
import { QueryRunner } from "typeorm";
import { AuthUserContext, CasePriority, CaseStatus, UserRole } from "@regops/shared";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { TenantGuard } from "../auth/guards/tenant.guard";
import { CurrentQueryRunner } from "../common/decorators/current-query-runner.decorator";
import { CurrentTenant } from "../common/decorators/current-tenant.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { Roles } from "../common/decorators/roles.decorator";
import { CasesService } from "./cases.service";
import { CreateCaseDto } from "./dto/create-case.dto";
import { ListCasesDto } from "./dto/list-cases.dto";

export const ANY_AUTHENTICATED = [UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.COMPLIANCE_OFFICER, UserRole.INVESTIGATOR, UserRole.VIEWER];
export const CREATE_ROLES = [UserRole.COMPLIANCE_OFFICER, UserRole.INVESTIGATOR];

export function requestMeta(req: Request) {
  return { ipAddress: req.ip ?? null, userAgent: req.header("user-agent") ?? null };
}

@ApiTags("cases")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
@Controller("cases")
export class CasesController {
  constructor(private readonly casesService: CasesService) {}

  @Post()
  @Roles(...CREATE_ROLES)
  async create(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() qr: QueryRunner,
    @Body() dto: CreateCaseDto,
    @CurrentUser() currentUser: AuthUserContext,
    @Req() req: Request,
  ) {
    return this.casesService.create(qr, tenantId, dto, currentUser, requestMeta(req));
  }

  @Get()
  @Roles(...ANY_AUTHENTICATED)
  async list(@CurrentTenant() tenantId: string, @CurrentQueryRunner() qr: QueryRunner, @Query() query: ListCasesDto) {
    const limit = Math.min(query.limit ?? 25, 100);
    return this.casesService.list(
      qr,
      tenantId,
      {
        statuses: query.status?.split(",") as CaseStatus[] | undefined,
        priorities: query.priority?.split(",") as CasePriority[] | undefined,
        assignedTo: query.assigned_to,
        q: query.q,
      },
      query.page ?? 1,
      limit,
    );
  }

  @Get(":id")
  @Roles(...ANY_AUTHENTICATED)
  async detail(@CurrentTenant() tenantId: string, @CurrentQueryRunner() qr: QueryRunner, @Param("id") id: string) {
    return this.casesService.toDetail(qr, tenantId, id);
  }
}
```

Note: `requestMeta`/`ANY_AUTHENTICATED`/`CREATE_ROLES` are exported (not module-private like `CustomersController`'s own `requestMeta`) because Tasks 4-9 add more endpoints to this same controller file and reuse them — avoids five near-identical private copies in one file.

- [ ] **Step 5: Write `apps/api/src/cases/cases.module.ts`**

```ts
import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { CasesController } from "./cases.controller";
import { CasesService } from "./cases.service";

/** Deliberately imports only AuditModule — every Customer/Alert/Transaction/
 * User row this module reads is accessed directly via @regops/db entities on
 * the request's own QueryRunner (same pattern AlertsService already uses for
 * TransactionEntity), so no CustomersModule/RulesModule/TransactionsModule
 * import is needed and the existing one-directional dependency rule
 * (nothing imports this module back) stays trivially true. */
@Module({
  imports: [AuditModule],
  controllers: [CasesController],
  providers: [CasesService],
  exports: [CasesService],
})
export class CasesModule {}
```

- [ ] **Step 6: Register `CasesModule` in `apps/api/src/app.module.ts`**

Add the import and add `CasesModule` to the `imports` array (after `RulesModule`):

```ts
import { CasesModule } from "./cases/cases.module";
```
```ts
    RulesModule,
    CasesModule,
```

- [ ] **Step 7: Add the 7 new entities to `apps/api/test/utils/test-app.ts`**

Add to the existing `@regops/db` import block: `CaseEntity, CaseAlertEntity, CaseAssignmentEventEntity, CaseNoteEntity, CaseEvidenceEntity, CaseApprovalEventEntity, ReportEntity` (alphabetical, matching the block's existing ordering). Add all 7 to the `adminDataSource`'s `entities` array in `createTestContext()`.

- [ ] **Step 8: Write `apps/api/test/cases.e2e-spec.ts`**

```ts
import request from "supertest";
import * as crypto from "crypto";
import { DataSource, QueryRunner } from "typeorm";
import { AlertEntity, CaseAlertEntity, CaseAssignmentEventEntity, CaseEntity, CustomerEntity, RuleEntity } from "@regops/db";
import { AlertSeverity, CasePriority, CaseStatus, CustomerType, RuleScenarioType, UserRole } from "@regops/shared";
import { AlertsService } from "../src/rules/alerts/alerts.service";
import {
  closeTestContext,
  createTenantFixture,
  createTestContext,
  createUserFixture,
  seedRiskFactorConfigsFixture,
  seedRuleCatalogFixture,
  seedScreeningProviderConfigsFixture,
  TestContext,
} from "./utils/test-app";

describe("Cases module (e2e)", () => {
  let ctx: TestContext;
  let tenantAId: string;
  let tenantBId: string;
  let appDataSource: DataSource;
  let alertsService: AlertsService;

  beforeAll(async () => {
    ctx = await createTestContext();
    tenantAId = (await createTenantFixture(ctx.adminDataSource)).id;
    tenantBId = (await createTenantFixture(ctx.adminDataSource)).id;
    await seedRiskFactorConfigsFixture(ctx.adminDataSource, tenantAId);
    await seedRiskFactorConfigsFixture(ctx.adminDataSource, tenantBId);
    await seedScreeningProviderConfigsFixture(ctx.adminDataSource, tenantAId);
    await seedScreeningProviderConfigsFixture(ctx.adminDataSource, tenantBId);
    await seedRuleCatalogFixture(ctx.adminDataSource, tenantAId);
    await seedRuleCatalogFixture(ctx.adminDataSource, tenantBId);
    appDataSource = ctx.app.get(DataSource);
    alertsService = ctx.app.get(AlertsService);
  });

  afterAll(async () => {
    await closeTestContext(ctx);
  });

  const http = () => request(ctx.app.getHttpServer());

  async function loginAs(email: string, password: string): Promise<string> {
    const res = await http().post("/auth/login").send({ email, password }).expect(200);
    return res.body.data.accessToken;
  }

  async function tokenFor(tenantId: string, role: UserRole, emailSuffix: string): Promise<string> {
    const { user, password } = await createUserFixture(ctx.adminDataSource, tenantId, { email: `cases-${emailSuffix}@test.dev`, role });
    return loginAs(user.email, password);
  }

  async function createCustomer(tenantId: string, overrides: Partial<CustomerEntity> = {}): Promise<CustomerEntity> {
    const repo = ctx.adminDataSource.getRepository(CustomerEntity);
    return repo.save(
      repo.create({
        tenantId,
        cbsCustomerId: `CUST-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        fullName: "Cases Test Customer",
        customerType: CustomerType.INDIVIDUAL,
        country: "NG",
        kycTier: 2,
        onboardedAt: new Date("2024-01-01"),
        isPep: false,
        isSanctioned: false,
        ...overrides,
      }),
    );
  }

  async function withQr<T>(tenantId: string, fn: (qr: QueryRunner) => Promise<T>): Promise<T> {
    const qr = appDataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await qr.query(`SELECT set_config('app.current_tenant_id', $1, true), set_config('app.bypass_rls', 'false', true)`, [tenantId]);
      const result = await fn(qr);
      await qr.commitTransaction();
      return result;
    } catch (err) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  async function createAlert(tenantId: string, customerId: string, severity: AlertSeverity = AlertSeverity.MEDIUM): Promise<AlertEntity> {
    const rule = await ctx.adminDataSource.getRepository(RuleEntity).findOneOrFail({ where: { tenantId, scenarioType: RuleScenarioType.LARGE_CASH } });
    const outcome = await withQr(tenantId, (qr) =>
      alertsService.createOrIncrement(qr, {
        tenantId,
        rule,
        customerId,
        triggeringTransactionId: null,
        severity,
        title: "Cases-test alert",
        evidence: {},
        dedupKey: `cases-test:${crypto.randomUUID()}`,
        firedAt: new Date(),
      }),
    );
    return outcome.alert;
  }

  describe("POST /cases — creation", () => {
    it("creates a bare case with an explicit customerId + priority, self-assigning the creator", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "bare-create");
      const customer = await createCustomer(tenantAId);

      const res = await http()
        .post("/cases")
        .set("Authorization", `Bearer ${token}`)
        .send({ customerId: customer.id, priority: CasePriority.HIGH })
        .expect(201);

      expect(res.body.data.status).toBe(CaseStatus.OPEN);
      expect(res.body.data.priority).toBe(CasePriority.HIGH);
      expect(res.body.data.caseNumber).toMatch(new RegExp(`^CASE-${new Date().getFullYear()}-\\d{4}$`));
      expect(res.body.data.alerts).toEqual([]);

      const assignmentEvents = await ctx.adminDataSource
        .getRepository(CaseAssignmentEventEntity)
        .find({ where: { tenantId: tenantAId, caseId: res.body.data.id } });
      expect(assignmentEvents).toHaveLength(1);
    });

    it("creates a case from an alertId — alert's customerId wins over any body customerId, priority derives from severity", async () => {
      const token = await tokenFor(tenantAId, UserRole.INVESTIGATOR, "from-alert");
      const customer = await createCustomer(tenantAId);
      const otherCustomer = await createCustomer(tenantAId);
      const alert = await createAlert(tenantAId, customer.id, AlertSeverity.CRITICAL);

      const res = await http()
        .post("/cases")
        .set("Authorization", `Bearer ${token}`)
        .send({ alertId: alert.id, customerId: otherCustomer.id })
        .expect(201);

      expect(res.body.data.customerId).toBe(customer.id);
      expect(res.body.data.priority).toBe(CasePriority.HIGH);
      expect(res.body.data.alerts).toHaveLength(1);
      expect(res.body.data.alerts[0].id).toBe(alert.id);
    });

    it("400 CUSTOMER_REQUIRED when neither customerId nor alertId is given", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "no-customer");
      const res = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({}).expect(400);
      expect(res.body.error.code).toBe("CUSTOMER_REQUIRED");
    });

    it("404 ALERT_NOT_FOUND for a nonexistent alertId", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "bad-alert");
      const res = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ alertId: crypto.randomUUID() }).expect(404);
      expect(res.body.error.code).toBe("ALERT_NOT_FOUND");
    });

    it("404 CUSTOMER_NOT_FOUND for a nonexistent customerId", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "bad-customer");
      const res = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ customerId: crypto.randomUUID() }).expect(404);
      expect(res.body.error.code).toBe("CUSTOMER_NOT_FOUND");
    });

    it("403 FORBIDDEN_ROLE for VIEWER", async () => {
      const token = await tokenFor(tenantAId, UserRole.VIEWER, "viewer-create");
      const customer = await createCustomer(tenantAId);
      await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ customerId: customer.id }).expect(403);
    });

    it("a customer/alert from a different tenant is 404, not visible cross-tenant", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "cross-tenant");
      const otherTenantCustomer = await createCustomer(tenantBId);
      const res = await http()
        .post("/cases")
        .set("Authorization", `Bearer ${token}`)
        .send({ customerId: otherTenantCustomer.id })
        .expect(404);
      expect(res.body.error.code).toBe("CUSTOMER_NOT_FOUND");
    });
  });

  describe("GET /cases, GET /cases/:id", () => {
    it("lists only the caller's tenant's cases and supports status/priority/q filters", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "list-basic");
      const customer = await createCustomer(tenantAId, { fullName: "Findable Person" });
      await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ customerId: customer.id }).expect(201);

      const res = await http().get("/cases").query({ q: "Findable" }).set("Authorization", `Bearer ${token}`).expect(200);
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
      expect(res.body.data.every((c: { customer: { fullName: string } | null }) => c.customer?.fullName === "Findable Person")).toBe(true);
    });

    it("a case belonging to another tenant is 404 on GET /cases/:id", async () => {
      const tokenB = await tokenFor(tenantBId, UserRole.COMPLIANCE_OFFICER, "tenantb-detail");
      const tokenA = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "tenanta-create");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${tokenA}`).send({ customerId: customer.id }).expect(201);

      await http().get(`/cases/${created.body.data.id}`).set("Authorization", `Bearer ${tokenB}`).expect(404);
    });

    it("VIEWER can view case list/detail (read is not role-gated beyond authentication)", async () => {
      const tokenViewer = await tokenFor(tenantAId, UserRole.VIEWER, "viewer-read");
      await http().get("/cases").set("Authorization", `Bearer ${tokenViewer}`).expect(200);
    });
  });
});
```

- [ ] **Step 9: Run the new e2e suite**

Run: `pnpm --filter api test:e2e -- cases.e2e-spec`
Expected: all tests in `cases.e2e-spec.ts` PASS against the real `docker-compose` Postgres.

- [ ] **Step 10: Run the full existing suite to confirm no regression**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e`
Expected: all PASS — confirms `CasesModule`'s registration into `app.module.ts` didn't break any existing module's wiring.

- [ ] **Step 11: Commit**

```bash
git add apps/api/src/cases apps/api/src/app.module.ts apps/api/test/utils/test-app.ts apps/api/test/cases.e2e-spec.ts
git commit -m "feat(cases): add case creation (3 entry points) and list/detail read endpoints"
```

---

## Task 4: Notes endpoint + auto-transition to UNDER_INVESTIGATION (trigger #1)

**Files:**
- Create: `apps/api/src/cases/case-notes.service.ts`
- Create: `apps/api/src/cases/dto/add-note.dto.ts`
- Modify: `apps/api/src/cases/cases.service.ts` (add `maybeStartInvestigation()`, add `listNotes()`, replace `toDetail()`'s `notes: []` line)
- Modify: `apps/api/src/cases/cases.module.ts` (register `CaseNotesService`)
- Modify: `apps/api/src/cases/cases.controller.ts` (add `POST /cases/:id/notes`)
- Modify: `apps/api/test/cases.e2e-spec.ts` (add a notes `describe` block)

**Interfaces:**
- Consumes: `CasesService.findEntity()` (Task 3), `CaseNoteEntity` (Task 2), `CaseNoteDto` (Task 1).
- Produces: `CasesService.maybeStartInvestigation(qr, tenantId, caseId): Promise<void>` — consumed by this task's `CaseNotesService.addNote()`, and later by Task 5's `CaseEvidenceService.upload()` and Task 10's `AlertStatusListener`. `CasesService.listNotes(qr, tenantId, caseId): Promise<CaseNoteDto[]>` — consumed by `toDetail()` here and unchanged after.

- [ ] **Step 1: Add `maybeStartInvestigation()` and `listNotes()` to `apps/api/src/cases/cases.service.ts`**

Add the `CaseNoteEntity` import to the existing `@regops/db` import line, and add these two public methods (anywhere after `findEntity`):

```ts
  /** Section 3.2: fires the first time a note is added, evidence is
   * uploaded, or a linked alert's status changes away from NEW — but ONLY
   * while the case is still OPEN (a case already UNDER_INVESTIGATION or
   * later doesn't re-fire or produce a duplicate transition). Callers MUST
   * invoke this inside their own already-open transaction — it does not
   * open or commit one itself. Silently no-ops on a stale/cross-tenant
   * caseId (the caller's own lookup already 404'd before reaching here in
   * every real call site; this only guards a hypothetical race). */
  async maybeStartInvestigation(qr: QueryRunner, tenantId: string, caseId: string): Promise<void> {
    const repo = qr.manager.getRepository(CaseEntity);
    const kase = await repo.findOne({ where: { id: caseId, tenantId } });
    if (!kase || kase.status !== CaseStatus.OPEN) return;
    await repo.update({ id: caseId }, { status: CaseStatus.UNDER_INVESTIGATION });
  }

  async listNotes(qr: QueryRunner, tenantId: string, caseId: string): Promise<CaseNoteDto[]> {
    const notes = await qr.manager.getRepository(CaseNoteEntity).find({ where: { tenantId, caseId }, order: { createdAt: "ASC" } });
    return notes.map((n) => ({ id: n.id, caseId: n.caseId, userId: n.userId, content: n.content, createdAt: n.createdAt.toISOString() }));
  }
```

Add the `CaseNoteDto` import to the existing `@regops/shared` import line.

- [ ] **Step 2: Replace `toDetail()`'s `notes: []` line**

```ts
      notes: await this.listNotes(qr, tenantId, id),
```

- [ ] **Step 3: Write `apps/api/src/cases/dto/add-note.dto.ts`**

```ts
import { IsString } from "class-validator";

/** Non-empty-after-trim is enforced server-side in CaseNotesService (400
 * CONTENT_REQUIRED), not here — same split as SubmitCaseDto's rationale
 * (Task 8): a whitespace-only string must still reach the service to get
 * the spec's specific error code, not a generic class-validator message. */
export class AddNoteDto {
  @IsString()
  content!: string;
}
```

- [ ] **Step 4: Write `apps/api/src/cases/case-notes.service.ts`**

```ts
import { BadRequestException, Injectable } from "@nestjs/common";
import { QueryRunner } from "typeorm";
import { CaseNoteEntity } from "@regops/db";
import { AuthUserContext, CaseNoteDto } from "@regops/shared";
import { AuditService } from "../audit/audit.service";
import { RequestMeta } from "../users/users.service";
import { CasesService } from "./cases.service";

@Injectable()
export class CaseNotesService {
  constructor(
    private readonly auditService: AuditService,
    private readonly casesService: CasesService,
  ) {}

  async addNote(
    qr: QueryRunner,
    tenantId: string,
    caseId: string,
    content: string,
    currentUser: AuthUserContext,
    meta: RequestMeta,
  ): Promise<CaseNoteDto> {
    const trimmed = content.trim();
    if (!trimmed) {
      throw new BadRequestException({ code: "CONTENT_REQUIRED", message: "Note content is required." });
    }

    await this.casesService.findEntity(qr, tenantId, caseId);

    await qr.startTransaction();
    try {
      const repo = qr.manager.getRepository(CaseNoteEntity);
      const note = await repo.save(repo.create({ tenantId, caseId, userId: currentUser.sub, content: trimmed }));

      await this.casesService.maybeStartInvestigation(qr, tenantId, caseId);

      await this.auditService.record(qr, {
        tenantId,
        userId: currentUser.sub,
        action: "case.note_added",
        entityType: "case",
        entityId: caseId,
        beforeState: null,
        afterState: { noteId: note.id },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      await qr.commitTransaction();
      return { id: note.id, caseId: note.caseId, userId: note.userId, content: note.content, createdAt: note.createdAt.toISOString() };
    } catch (err) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw err;
    }
  }
}
```

- [ ] **Step 5: Register `CaseNotesService` in `apps/api/src/cases/cases.module.ts`**

Add `CaseNotesService` to both `providers` and `exports`.

- [ ] **Step 6: Add the notes endpoint to `apps/api/src/cases/cases.controller.ts`**

Add the import (`CaseNotesService`, `AddNoteDto`), inject `CaseNotesService` in the constructor, add a `NOTES_EVIDENCE_LINK_ROLES` export (`[UserRole.COMPLIANCE_OFFICER, UserRole.INVESTIGATOR]`, reused by Tasks 5/7), and add:

```ts
  @Post(":id/notes")
  @Roles(...NOTES_EVIDENCE_LINK_ROLES)
  async addNote(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() qr: QueryRunner,
    @Param("id") id: string,
    @Body() dto: AddNoteDto,
    @CurrentUser() currentUser: AuthUserContext,
    @Req() req: Request,
  ) {
    return this.caseNotesService.addNote(qr, tenantId, id, dto.content, currentUser, requestMeta(req));
  }
```

- [ ] **Step 7: Add notes e2e tests to `apps/api/test/cases.e2e-spec.ts`**

```ts
  describe("POST /cases/:id/notes", () => {
    it("adds a note and auto-transitions an OPEN case to UNDER_INVESTIGATION", async () => {
      const token = await tokenFor(tenantAId, UserRole.INVESTIGATOR, "note-transition");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ customerId: customer.id }).expect(201);
      expect(created.body.data.status).toBe(CaseStatus.OPEN);

      const noteRes = await http()
        .post(`/cases/${created.body.data.id}/notes`)
        .set("Authorization", `Bearer ${token}`)
        .send({ content: "Reviewed the customer's transaction history." })
        .expect(201);
      expect(noteRes.body.data.content).toBe("Reviewed the customer's transaction history.");

      const detail = await http().get(`/cases/${created.body.data.id}`).set("Authorization", `Bearer ${token}`).expect(200);
      expect(detail.body.data.status).toBe(CaseStatus.UNDER_INVESTIGATION);
      expect(detail.body.data.notes).toHaveLength(1);
    });

    it("adding a second note to an already-UNDER_INVESTIGATION case does not error or regress status", async () => {
      const token = await tokenFor(tenantAId, UserRole.INVESTIGATOR, "note-idempotent");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ customerId: customer.id }).expect(201);
      await http().post(`/cases/${created.body.data.id}/notes`).set("Authorization", `Bearer ${token}`).send({ content: "First note." }).expect(201);
      await http().post(`/cases/${created.body.data.id}/notes`).set("Authorization", `Bearer ${token}`).send({ content: "Second note." }).expect(201);

      const detail = await http().get(`/cases/${created.body.data.id}`).set("Authorization", `Bearer ${token}`).expect(200);
      expect(detail.body.data.status).toBe(CaseStatus.UNDER_INVESTIGATION);
      expect(detail.body.data.notes).toHaveLength(2);
    });

    it("400 CONTENT_REQUIRED for empty/whitespace-only content", async () => {
      const token = await tokenFor(tenantAId, UserRole.INVESTIGATOR, "note-empty");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ customerId: customer.id }).expect(201);
      const res = await http()
        .post(`/cases/${created.body.data.id}/notes`)
        .set("Authorization", `Bearer ${token}`)
        .send({ content: "   " })
        .expect(400);
      expect(res.body.error.code).toBe("CONTENT_REQUIRED");
    });

    it("403 FORBIDDEN_ROLE for VIEWER", async () => {
      const tokenCreator = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "note-viewer-setup");
      const tokenViewer = await tokenFor(tenantAId, UserRole.VIEWER, "note-viewer");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${tokenCreator}`).send({ customerId: customer.id }).expect(201);
      await http().post(`/cases/${created.body.data.id}/notes`).set("Authorization", `Bearer ${tokenViewer}`).send({ content: "x" }).expect(403);
    });

    it("404 CASE_NOT_FOUND for a case in a different tenant", async () => {
      const tokenA = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "note-tenanta");
      const tokenB = await tokenFor(tenantBId, UserRole.COMPLIANCE_OFFICER, "note-tenantb");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${tokenA}`).send({ customerId: customer.id }).expect(201);
      await http().post(`/cases/${created.body.data.id}/notes`).set("Authorization", `Bearer ${tokenB}`).send({ content: "x" }).expect(404);
    });
  });
```

- [ ] **Step 8: Run the e2e suite**

Run: `pnpm --filter api test:e2e -- cases.e2e-spec`
Expected: all PASS, including the new notes/auto-transition assertions.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/cases apps/api/test/cases.e2e-spec.ts
git commit -m "feat(cases): add notes endpoint and auto-transition to UNDER_INVESTIGATION"
```

---

## Task 5: Evidence via FileStorage + auto-transition (trigger #2)

**Files:**
- Create: `apps/api/src/cases/case-evidence.service.ts`
- Modify: `apps/api/src/cases/cases.service.ts` (add `listEvidence()`, replace `toDetail()`'s `evidence: []` line)
- Modify: `apps/api/src/cases/cases.module.ts` (register `CaseEvidenceService`)
- Modify: `apps/api/src/cases/cases.controller.ts` (add `POST /cases/:id/evidence`, `GET /cases/:id/evidence/:evidenceId`)
- Modify: `apps/api/test/cases.e2e-spec.ts` (add an evidence `describe` block)

**Interfaces:**
- Consumes: `CasesService.findEntity()`, `CasesService.maybeStartInvestigation()` (Task 4); `CaseEvidenceEntity` (Task 2); `CaseEvidenceDto` (Task 1); `FileStorage`/`LocalFileStorage` (`@regops/file-storage`, existing).
- Produces: `CaseEvidenceService.upload()`, `CaseEvidenceService.getStream()` — consumed only by the controller. `CasesService.listEvidence(qr, tenantId, caseId): Promise<CaseEvidenceDto[]>` — a trivial read-only query kept on `CasesService` itself (not `CaseEvidenceService`) specifically to avoid a circular DI dependency (`CaseEvidenceService` already depends on `CasesService` for `findEntity`/`maybeStartInvestigation`; if `toDetail()` needed something back from `CaseEvidenceService`, that would be circular) — same resolution as Task 4's `listNotes()`.

- [ ] **Step 1: Add `listEvidence()` to `apps/api/src/cases/cases.service.ts`**

Add `CaseEvidenceEntity` to the existing `@regops/db` import and `CaseEvidenceDto` to the existing `@regops/shared` import. Add the method (anywhere near `listNotes`):

```ts
  async listEvidence(qr: QueryRunner, tenantId: string, caseId: string): Promise<CaseEvidenceDto[]> {
    const rows = await qr.manager.getRepository(CaseEvidenceEntity).find({ where: { tenantId, caseId }, order: { createdAt: "ASC" } });
    return rows.map((e) => ({
      id: e.id,
      caseId: e.caseId,
      fileName: e.fileName,
      fileType: e.fileType,
      fileSizeBytes: e.fileSizeBytes,
      uploadedBy: e.uploadedBy,
      createdAt: e.createdAt.toISOString(),
    }));
  }
```

- [ ] **Step 2: Replace `toDetail()`'s `evidence: []` line**

```ts
      evidence: await this.listEvidence(qr, tenantId, id),
```

- [ ] **Step 3: Write `apps/api/src/cases/case-evidence.service.ts`**

```ts
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import * as crypto from "crypto";
import * as path from "path";
import { Readable } from "stream";
import { QueryRunner } from "typeorm";
import { CaseEvidenceEntity } from "@regops/db";
import { FileStorage, LocalFileStorage } from "@regops/file-storage";
import { AuthUserContext, CaseEvidenceDto } from "@regops/shared";
import { AuditService } from "../audit/audit.service";
import { RequestMeta } from "../users/users.service";
import { CasesService } from "./cases.service";

const MAX_EVIDENCE_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Section 2.5: PDF, JPEG, PNG, DOCX, CSV — MIME type -> canonical extension. */
const ALLOWED_EVIDENCE_MIME_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "text/csv": "csv",
};

/** Filename extensions accepted per canonical type — jpg/jpeg both map to the jpeg MIME type. */
const VALID_EXTENSIONS_FOR: Record<string, string[]> = {
  pdf: ["pdf"],
  jpg: ["jpg", "jpeg"],
  png: ["png"],
  docx: ["docx"],
  csv: ["csv"],
};

@Injectable()
export class CaseEvidenceService {
  private readonly storage: FileStorage;

  constructor(
    private readonly auditService: AuditService,
    private readonly casesService: CasesService,
  ) {
    const localStorageDir = process.env.LOCAL_STORAGE_DIR ?? path.resolve(__dirname, "../../../../.local-storage");
    this.storage = new LocalFileStorage(localStorageDir);
  }

  /** Section 3.4: validated by BOTH MIME type and filename extension — don't
   * trust either alone. Unlike CustomersController's photo upload (which
   * relies on Multer's own `limits.fileSize`, accepting whatever generic
   * error results from exceeding it), this endpoint's FileInterceptor sets
   * NO multer size limit — size is checked explicitly below so an oversized
   * file gets the spec's exact 400 FILE_TOO_LARGE, not an uncaught
   * MulterError surfacing as a 500 through AllExceptionsFilter. */
  async upload(
    qr: QueryRunner,
    tenantId: string,
    caseId: string,
    file: Express.Multer.File,
    currentUser: AuthUserContext,
    meta: RequestMeta,
  ): Promise<CaseEvidenceDto> {
    const ext = ALLOWED_EVIDENCE_MIME_TYPES[file.mimetype];
    if (!ext) {
      throw new BadRequestException({
        code: "INVALID_FILE_TYPE",
        message: `Unsupported content type '${file.mimetype}'. Allowed: PDF, JPEG, PNG, DOCX, CSV.`,
      });
    }
    const originalExt = path.extname(file.originalname).toLowerCase().replace(".", "");
    if (!VALID_EXTENSIONS_FOR[ext].includes(originalExt)) {
      throw new BadRequestException({
        code: "INVALID_FILE_TYPE",
        message: `File extension '.${originalExt}' does not match content type '${file.mimetype}'.`,
      });
    }
    if (file.size > MAX_EVIDENCE_UPLOAD_BYTES) {
      throw new BadRequestException({ code: "FILE_TOO_LARGE", message: "Evidence files must be 10MB or smaller." });
    }

    await this.casesService.findEntity(qr, tenantId, caseId);

    const evidenceId = crypto.randomUUID();
    const key = `tenants/${tenantId}/cases/${caseId}/evidence/${evidenceId}.${ext}`;

    // Uploaded to FileStorage before the DB write — same "no DB row ever
    // points at a file that doesn't exist" ordering as CustomersService.uploadPhoto.
    await this.storage.upload(key, Readable.from(file.buffer));

    await qr.startTransaction();
    try {
      const repo = qr.manager.getRepository(CaseEvidenceEntity);
      const evidence = await repo.save(
        repo.create({
          id: evidenceId,
          tenantId,
          caseId,
          fileName: file.originalname,
          fileKey: key,
          fileType: file.mimetype,
          fileSizeBytes: file.size,
          uploadedBy: currentUser.sub,
        }),
      );

      await this.casesService.maybeStartInvestigation(qr, tenantId, caseId);

      await this.auditService.record(qr, {
        tenantId,
        userId: currentUser.sub,
        action: "case.evidence_uploaded",
        entityType: "case",
        entityId: caseId,
        beforeState: null,
        afterState: { evidenceId: evidence.id, fileName: evidence.fileName },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      await qr.commitTransaction();
      return this.toDto(evidence);
    } catch (err) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw err;
    }
  }

  /** Proxied through the API (not a signed URL) — LocalFileStorage.getSignedDownloadUrl
   * always returns null, same reasoning as CustomersController's photo download. Still
   * writes an audit row (Section 2.5: both upload and download are audit-logged), so
   * this wraps that single write in its own savepoint like every other audited action. */
  async getStream(
    qr: QueryRunner,
    tenantId: string,
    caseId: string,
    evidenceId: string,
    currentUser: AuthUserContext,
    meta: RequestMeta,
  ): Promise<{ stream: Readable; contentType: string; fileName: string }> {
    await this.casesService.findEntity(qr, tenantId, caseId);
    const evidence = await qr.manager.getRepository(CaseEvidenceEntity).findOne({ where: { id: evidenceId, tenantId, caseId } });
    if (!evidence) throw new NotFoundException({ code: "EVIDENCE_NOT_FOUND", message: "Evidence not found." });

    const stream = await this.storage.getReadStream(evidence.fileKey);

    await qr.startTransaction();
    try {
      await this.auditService.record(qr, {
        tenantId,
        userId: currentUser.sub,
        action: "case.evidence_downloaded",
        entityType: "case",
        entityId: caseId,
        beforeState: null,
        afterState: { evidenceId: evidence.id },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      await qr.commitTransaction();
    } catch (err) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw err;
    }

    return { stream, contentType: evidence.fileType, fileName: evidence.fileName };
  }

  private toDto(e: CaseEvidenceEntity): CaseEvidenceDto {
    return {
      id: e.id,
      caseId: e.caseId,
      fileName: e.fileName,
      fileType: e.fileType,
      fileSizeBytes: e.fileSizeBytes,
      uploadedBy: e.uploadedBy,
      createdAt: e.createdAt.toISOString(),
    };
  }
}
```

- [ ] **Step 4: Register `CaseEvidenceService` in `apps/api/src/cases/cases.module.ts`**

Add `CaseEvidenceService` to both `providers` and `exports`.

- [ ] **Step 5: Add the evidence endpoints to `apps/api/src/cases/cases.controller.ts`**

Add imports (`UploadedFile`, `UseInterceptors`, `Res`, `HttpCode`, `HttpStatus` from `@nestjs/common`; `FileInterceptor` from `@nestjs/platform-express`; `memoryStorage` from `multer`; `Response` from `express`; `CaseEvidenceService`), inject `CaseEvidenceService` in the constructor, and add:

```ts
  // No multer `limits.fileSize` here — see CaseEvidenceService.upload's docblock.
  @Post(":id/evidence")
  @Roles(...NOTES_EVIDENCE_LINK_ROLES)
  @UseInterceptors(FileInterceptor("file", { storage: memoryStorage() }))
  async uploadEvidence(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() qr: QueryRunner,
    @Param("id") id: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() currentUser: AuthUserContext,
    @Req() req: Request,
  ) {
    if (!file) {
      throw new BadRequestException({ code: "FILE_REQUIRED", message: "An evidence file ('file' field) is required." });
    }
    return this.caseEvidenceService.upload(qr, tenantId, id, file, currentUser, requestMeta(req));
  }

  @Get(":id/evidence/:evidenceId")
  @Roles(...ANY_AUTHENTICATED)
  async downloadEvidence(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() qr: QueryRunner,
    @Param("id") id: string,
    @Param("evidenceId") evidenceId: string,
    @CurrentUser() currentUser: AuthUserContext,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const { stream, contentType, fileName } = await this.caseEvidenceService.getStream(qr, tenantId, id, evidenceId, currentUser, requestMeta(req));
    res.setHeader("content-type", contentType);
    res.setHeader("content-disposition", `attachment; filename="${fileName.replace(/"/g, "")}"`);
    stream.pipe(res);
  }
```

Also add `BadRequestException` to the existing `@nestjs/common` import if not already present (it isn't yet in this controller).

- [ ] **Step 6: Add evidence e2e tests to `apps/api/test/cases.e2e-spec.ts`**

Add `AuditLogEntity` to the existing `@regops/db` import. Add:

```ts
  describe("Evidence upload/download", () => {
    it("uploads a PDF, auto-transitions OPEN -> UNDER_INVESTIGATION, and downloads it back byte-for-byte", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "evidence-roundtrip");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ customerId: customer.id }).expect(201);
      const caseId = created.body.data.id;
      const fileContents = Buffer.from("%PDF-1.4 test evidence content");

      const uploadRes = await http()
        .post(`/cases/${caseId}/evidence`)
        .set("Authorization", `Bearer ${token}`)
        .attach("file", fileContents, { filename: "statement.pdf", contentType: "application/pdf" })
        .expect(201);
      expect(uploadRes.body.data.fileName).toBe("statement.pdf");

      const detail = await http().get(`/cases/${caseId}`).set("Authorization", `Bearer ${token}`).expect(200);
      expect(detail.body.data.status).toBe(CaseStatus.UNDER_INVESTIGATION);
      expect(detail.body.data.evidence).toHaveLength(1);

      const downloadRes = await http()
        .get(`/cases/${caseId}/evidence/${uploadRes.body.data.id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(Buffer.compare(downloadRes.body, fileContents)).toBe(0);

      const auditRows = await ctx.adminDataSource
        .getRepository(AuditLogEntity)
        .find({ where: { tenantId: tenantAId, entityId: caseId, action: "case.evidence_uploaded" } });
      expect(auditRows.length).toBeGreaterThanOrEqual(1);
      const downloadAuditRows = await ctx.adminDataSource
        .getRepository(AuditLogEntity)
        .find({ where: { tenantId: tenantAId, entityId: caseId, action: "case.evidence_downloaded" } });
      expect(downloadAuditRows.length).toBeGreaterThanOrEqual(1);
    });

    it("400 INVALID_FILE_TYPE for a disallowed content type", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "evidence-bad-type");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ customerId: customer.id }).expect(201);

      const res = await http()
        .post(`/cases/${created.body.data.id}/evidence`)
        .set("Authorization", `Bearer ${token}`)
        .attach("file", Buffer.from("#!/bin/sh"), { filename: "script.sh", contentType: "application/x-sh" })
        .expect(400);
      expect(res.body.error.code).toBe("INVALID_FILE_TYPE");
    });

    it("400 FILE_TOO_LARGE for a file over 10MB", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "evidence-too-large");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ customerId: customer.id }).expect(201);
      const oversized = Buffer.alloc(10 * 1024 * 1024 + 1, 1);

      const res = await http()
        .post(`/cases/${created.body.data.id}/evidence`)
        .set("Authorization", `Bearer ${token}`)
        .attach("file", oversized, { filename: "big.csv", contentType: "text/csv" })
        .expect(400);
      expect(res.body.error.code).toBe("FILE_TOO_LARGE");
    });

    it("403 FORBIDDEN_ROLE for VIEWER on upload", async () => {
      const tokenCreator = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "evidence-viewer-setup");
      const tokenViewer = await tokenFor(tenantAId, UserRole.VIEWER, "evidence-viewer");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${tokenCreator}`).send({ customerId: customer.id }).expect(201);
      await http()
        .post(`/cases/${created.body.data.id}/evidence`)
        .set("Authorization", `Bearer ${tokenViewer}`)
        .attach("file", Buffer.from("csv,data"), { filename: "x.csv", contentType: "text/csv" })
        .expect(403);
    });
  });
```

- [ ] **Step 7: Run the e2e suite**

Run: `pnpm --filter api test:e2e -- cases.e2e-spec`
Expected: all PASS, including the byte-for-byte round trip and both audit-log assertions.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/cases apps/api/test/cases.e2e-spec.ts
git commit -m "feat(cases): add FileStorage-backed evidence upload/download with type/size validation"
```

---

## Task 6: Escalation checklist service + endpoint

**Files:**
- Modify: `apps/api/src/cases/cases.service.ts` (add `getDerivedTransactions()`, `computeChecklist()`, `isRiskScoreCurrent()`; replace `toDetail()`'s `transactions: []` and `checklist: {...}` lines)
- Modify: `apps/api/src/cases/cases.controller.ts` (add `GET /cases/:id/checklist`)
- Modify: `apps/api/test/cases.e2e-spec.ts` (add a checklist `describe` block)

**Interfaces:**
- Consumes: `CasesService.linkedAlerts()` (Task 3), `CaseNoteEntity` (Task 2), `TransactionEntity` (existing).
- Produces: `CasesService.getDerivedTransactions(qr, tenantId, caseId): Promise<TransactionDto[]>` — consumed by `toDetail()` here and by Task 11's timeline (one "transaction" event per derived transaction). `CasesService.computeChecklist(qr, tenantId, caseId): Promise<CaseChecklistDto>` — the single source of truth used by both `GET /cases/:id/checklist` and Task 8's submit-for-approval guard (per Section 3.6: "do not implement this logic twice").

- [ ] **Step 1: Add `getDerivedTransactions()`, `computeChecklist()`, `isRiskScoreCurrent()` to `apps/api/src/cases/cases.service.ts`**

Add `TransactionEntity` to the existing `@regops/db` import, `AlertStatus, CaseChecklistDto, CaseChecklistItemDto, RiskLevel, TransactionDto` to the existing `@regops/shared` import.

```ts
  /** Section 3.7: derived transitively via each linked alert's own
   * evidence.relatedTransactionIds (the exact same field AlertsService.
   * relatedTransactions reads for a single alert) — deduped and sorted by
   * occurredAt. A case with zero linked alerts always has zero transactions
   * here, regardless of what evidence records exist. */
  async getDerivedTransactions(qr: QueryRunner, tenantId: string, caseId: string): Promise<TransactionDto[]> {
    const alerts = await this.linkedAlerts(qr, tenantId, caseId);
    const ids = new Set<string>();
    for (const alert of alerts) {
      const related = Array.isArray(alert.evidence?.relatedTransactionIds) ? (alert.evidence.relatedTransactionIds as string[]) : [];
      for (const id of related) ids.add(id);
    }
    if (ids.size === 0) return [];

    const rows = await qr.manager
      .getRepository(TransactionEntity)
      .createQueryBuilder("t")
      .where("t.tenant_id = :tenantId", { tenantId })
      .andWhere("t.id IN (:...ids)", { ids: Array.from(ids) })
      .getMany();

    return rows
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
      .map((t) => ({
        id: t.id,
        tenantId: t.tenantId,
        cbsTransactionId: t.cbsTransactionId,
        customerId: t.customerId,
        accountNumber: t.accountNumber,
        amount: t.amount,
        currency: t.currency,
        type: t.type,
        channel: t.channel,
        counterpartyAccount: t.counterpartyAccount,
        counterpartyBank: t.counterpartyBank,
        counterpartyName: t.counterpartyName,
        counterpartyCustomerId: t.counterpartyCustomerId,
        narration: t.narration,
        reference: t.reference,
        balanceAfter: t.balanceAfter,
        occurredAt: t.occurredAt.toISOString(),
        ingestedAt: t.ingestedAt.toISOString(),
        source: t.source,
        ingestionBatchId: t.ingestionBatchId,
      }));
  }

  /** Section 3.6 item 4: cadence by risk band — CRITICAL/HIGH 1 day, MEDIUM 7 days, LOW 30 days. */
  private isRiskScoreCurrent(customer: CustomerEntity | null): boolean {
    if (!customer || !customer.lastRiskCalculatedAt) return false;
    const cadenceDays: Record<RiskLevel, number> = {
      [RiskLevel.CRITICAL]: 1,
      [RiskLevel.HIGH]: 1,
      [RiskLevel.MEDIUM]: 7,
      [RiskLevel.LOW]: 30,
    };
    const ageMs = Date.now() - customer.lastRiskCalculatedAt.getTime();
    return ageMs <= cadenceDays[customer.riskLevel] * 24 * 60 * 60 * 1000;
  }

  /** Section 3.6 — the single source of truth for both GET /cases/:id/checklist
   * and Task 8's submit-for-approval guard. Item 3 is deliberately stricter
   * than item 1 (`every`, not `any`): a case with two linked alerts, one
   * reviewed and one still NEW, passes item 1 but fails item 3. */
  async computeChecklist(qr: QueryRunner, tenantId: string, caseId: string): Promise<CaseChecklistDto> {
    const kase = await this.findEntity(qr, tenantId, caseId);
    const alerts = await this.linkedAlerts(qr, tenantId, caseId);
    const noteCount = await qr.manager.getRepository(CaseNoteEntity).count({ where: { tenantId, caseId } });
    const transactions = await this.getDerivedTransactions(qr, tenantId, caseId);
    const customer = await qr.manager.getRepository(CustomerEntity).findOne({ where: { id: kase.customerId, tenantId } });

    const items: CaseChecklistItemDto[] = [
      { key: "ALERT_REVIEWED", label: "At least one linked alert reviewed", passed: alerts.some((a) => a.status !== AlertStatus.NEW) },
      { key: "NOTE_ADDED", label: "At least one investigation note added", passed: noteCount > 0 },
      {
        key: "TRANSACTIONS_REVIEWED",
        label: "Linked transactions reviewed",
        passed: transactions.length === 0 || alerts.every((a) => a.status !== AlertStatus.NEW),
      },
      { key: "RISK_SCORE_CURRENT", label: "Customer risk score is current", passed: this.isRiskScoreCurrent(customer) },
    ];

    return { items, complete: items.every((i) => i.passed) };
  }
```

- [ ] **Step 2: Replace `toDetail()`'s `transactions: []` and `checklist: {...}` lines**

```ts
      transactions: await this.getDerivedTransactions(qr, tenantId, id),
      checklist: await this.computeChecklist(qr, tenantId, id),
```

- [ ] **Step 3: Add the checklist endpoint to `apps/api/src/cases/cases.controller.ts`**

```ts
  @Get(":id/checklist")
  @Roles(...ANY_AUTHENTICATED)
  async checklist(@CurrentTenant() tenantId: string, @CurrentQueryRunner() qr: QueryRunner, @Param("id") id: string) {
    return this.casesService.computeChecklist(qr, tenantId, id);
  }
```

- [ ] **Step 4: Add checklist e2e tests to `apps/api/test/cases.e2e-spec.ts`**

Add `CaseAlertEntity, TransactionEntity` (if not already imported) and `AlertStatus, RiskLevel, TransactionChannel, TransactionSource, TransactionType` to the existing imports. Add a `createTransaction` helper (same shape as `rules.e2e-spec.ts`'s own) and extend `createAlert` to accept an optional linked transaction id:

```ts
  async function createTransaction(tenantId: string, customerId: string, overrides: Partial<TransactionEntity> = {}): Promise<TransactionEntity> {
    const repo = ctx.adminDataSource.getRepository(TransactionEntity);
    return repo.save(
      repo.create({
        id: crypto.randomUUID(),
        tenantId,
        cbsTransactionId: `TXN-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        customerId,
        accountNumber: "0123456789",
        amount: "50000",
        currency: "NGN",
        type: TransactionType.CREDIT,
        channel: TransactionChannel.MOBILE,
        counterpartyAccount: null,
        counterpartyBank: null,
        counterpartyName: null,
        counterpartyCustomerId: null,
        narration: null,
        reference: null,
        balanceAfter: null,
        occurredAt: new Date(),
        source: TransactionSource.MANUAL,
        ingestionBatchId: null,
        ...overrides,
      }),
    );
  }
```

Update `createAlert`'s signature to `createAlert(tenantId, customerId, severity = AlertSeverity.MEDIUM, relatedTransactionIds: string[] = [])` and pass `evidence: { relatedTransactionIds }` instead of `evidence: {}` in its `createOrIncrement` call.

```ts
  describe("GET /cases/:id/checklist", () => {
    it("item 1/3 any-vs-every distinction: one reviewed + one still-NEW alert passes item 1 but fails item 3", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "checklist-any-every");
      const customer = await createCustomer(tenantAId);
      const txn = await createTransaction(tenantAId, customer.id);
      const reviewedAlert = await createAlert(tenantAId, customer.id, AlertSeverity.MEDIUM, [txn.id]);
      const newAlert = await createAlert(tenantAId, customer.id, AlertSeverity.MEDIUM, [txn.id]);
      await ctx.adminDataSource.getRepository(AlertEntity).update({ id: reviewedAlert.id }, { status: AlertStatus.ASSIGNED });

      const created = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ alertId: reviewedAlert.id }).expect(201);
      // Second alert linked directly (Task 7's link endpoint doesn't exist yet) —
      // checklist logic only cares that a case_alert row exists, not how it got there.
      await ctx.adminDataSource.getRepository(CaseAlertEntity).save(
        ctx.adminDataSource.getRepository(CaseAlertEntity).create({
          tenantId: tenantAId,
          caseId: created.body.data.id,
          alertId: newAlert.id,
          linkedAt: new Date(),
          linkedBy: created.body.data.createdBy,
        }),
      );

      const res = await http().get(`/cases/${created.body.data.id}/checklist`).set("Authorization", `Bearer ${token}`).expect(200);
      const byKey = Object.fromEntries(res.body.data.items.map((i: { key: string; passed: boolean }) => [i.key, i.passed]));
      expect(byKey.ALERT_REVIEWED).toBe(true);
      expect(byKey.TRANSACTIONS_REVIEWED).toBe(false);
      expect(res.body.data.complete).toBe(false);
    });

    it("item 2 (note added) is independent of alerts", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "checklist-note");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ customerId: customer.id }).expect(201);

      let res = await http().get(`/cases/${created.body.data.id}/checklist`).set("Authorization", `Bearer ${token}`).expect(200);
      expect(res.body.data.items.find((i: { key: string }) => i.key === "NOTE_ADDED").passed).toBe(false);

      await http().post(`/cases/${created.body.data.id}/notes`).set("Authorization", `Bearer ${token}`).send({ content: "note" }).expect(201);
      res = await http().get(`/cases/${created.body.data.id}/checklist`).set("Authorization", `Bearer ${token}`).expect(200);
      expect(res.body.data.items.find((i: { key: string }) => i.key === "NOTE_ADDED").passed).toBe(true);
    });

    it("item 4: false when lastRiskCalculatedAt is null; true when within the risk band's cadence; false when stale", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "checklist-risk");
      const customerRepo = ctx.adminDataSource.getRepository(CustomerEntity);
      const customer = await createCustomer(tenantAId, { riskLevel: RiskLevel.HIGH, lastRiskCalculatedAt: null });
      const created = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ customerId: customer.id }).expect(201);

      let res = await http().get(`/cases/${created.body.data.id}/checklist`).set("Authorization", `Bearer ${token}`).expect(200);
      expect(res.body.data.items.find((i: { key: string }) => i.key === "RISK_SCORE_CURRENT").passed).toBe(false);

      await customerRepo.update({ id: customer.id }, { lastRiskCalculatedAt: new Date() }); // HIGH cadence = 1 day
      res = await http().get(`/cases/${created.body.data.id}/checklist`).set("Authorization", `Bearer ${token}`).expect(200);
      expect(res.body.data.items.find((i: { key: string }) => i.key === "RISK_SCORE_CURRENT").passed).toBe(true);

      await customerRepo.update({ id: customer.id }, { lastRiskCalculatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) });
      res = await http().get(`/cases/${created.body.data.id}/checklist`).set("Authorization", `Bearer ${token}`).expect(200);
      expect(res.body.data.items.find((i: { key: string }) => i.key === "RISK_SCORE_CURRENT").passed).toBe(false);
    });

    it("is included directly in GET /cases/:id detail", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "checklist-in-detail");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ customerId: customer.id }).expect(201);
      const detail = await http().get(`/cases/${created.body.data.id}`).set("Authorization", `Bearer ${token}`).expect(200);
      expect(detail.body.data.checklist.items).toHaveLength(4);
    });
  });
```

- [ ] **Step 5: Run the e2e suite**

Run: `pnpm --filter api test:e2e -- cases.e2e-spec`
Expected: all PASS, including the any-vs-every distinction and all three risk-cadence states.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/cases apps/api/test/cases.e2e-spec.ts
git commit -m "feat(cases): add escalation checklist computation and endpoint"
```

---

## Task 7: Link an existing alert to an already-open case

**Files:**
- Create: `apps/api/src/cases/dto/link-alert.dto.ts`
- Modify: `apps/api/src/cases/cases.service.ts` (add `linkAlert()`)
- Modify: `apps/api/src/cases/cases.controller.ts` (add `POST /cases/:id/alerts`)
- Modify: `apps/api/test/cases.e2e-spec.ts` (add an alert-linking `describe` block)

**Interfaces:**
- Consumes: `CasesService.findEntity()`, `CasesService.toDetail()` (Task 3); `CaseAlertEntity` (Task 2).
- Produces: `CasesService.linkAlert(qr, tenantId, caseId, alertId, currentUser, meta): Promise<CaseDetailDto>` — consumed only by the controller. No other task depends on this method's internals, but Task 11's timeline reads the `case_alert` rows it creates (via `linked_at > case.created_at` to distinguish post-creation links from creation-time links).

- [ ] **Step 1: Write `apps/api/src/cases/dto/link-alert.dto.ts`**

```ts
import { IsUUID } from "class-validator";

export class LinkAlertDto {
  @IsUUID()
  alertId!: string;
}
```

- [ ] **Step 2: Add `linkAlert()` to `apps/api/src/cases/cases.service.ts`**

```ts
  /** Section 2.3/3.5. The existingLink pre-check plus the migration's
   * unique-on-alert_id index together satisfy Section 3.5's instruction to
   * "check the constraint at the application level for a clean error, not
   * just letting the DB constraint throw" — a genuinely concurrent double-
   * link race (two requests linking the same alert at the same instant)
   * would still surface as a raw constraint-violation 500 from the small
   * window between this check and the insert; that residual race is
   * accepted, not additionally guarded (same class of limitation as
   * nextCaseNumber's case-number race — the spec doesn't ask for advisory
   * locking here). */
  async linkAlert(
    qr: QueryRunner,
    tenantId: string,
    caseId: string,
    alertId: string,
    currentUser: AuthUserContext,
    meta: RequestMeta,
  ): Promise<CaseDetailDto> {
    const kase = await this.findEntity(qr, tenantId, caseId);
    if (kase.status === CaseStatus.CLOSED || kase.status === CaseStatus.SAR_FILED) {
      throw new BadRequestException({ code: "CASE_ALREADY_TERMINAL", message: "Cannot link an alert to a closed or filed case." });
    }

    const alert = await qr.manager.getRepository(AlertEntity).findOne({ where: { id: alertId, tenantId } });
    if (!alert) throw new NotFoundException({ code: "ALERT_NOT_FOUND", message: "Alert not found." });
    if (alert.customerId !== kase.customerId) {
      throw new BadRequestException({ code: "ALERT_CUSTOMER_MISMATCH", message: "This alert does not belong to the case's customer." });
    }

    const existingLink = await qr.manager.getRepository(CaseAlertEntity).findOne({ where: { tenantId, alertId } });
    if (existingLink) {
      throw new BadRequestException({ code: "ALERT_ALREADY_LINKED", message: "This alert is already linked to a case." });
    }

    await qr.startTransaction();
    try {
      const repo = qr.manager.getRepository(CaseAlertEntity);
      await repo.save(repo.create({ tenantId, caseId, alertId, linkedAt: new Date(), linkedBy: currentUser.sub }));

      await this.auditService.record(qr, {
        tenantId,
        userId: currentUser.sub,
        action: "case.alert_linked",
        entityType: "case",
        entityId: caseId,
        beforeState: null,
        afterState: { alertId },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      await qr.commitTransaction();
      return this.toDetail(qr, tenantId, caseId);
    } catch (err) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw err;
    }
  }
```

- [ ] **Step 3: Add the endpoint to `apps/api/src/cases/cases.controller.ts`**

Add the `LinkAlertDto` import and:

```ts
  @Post(":id/alerts")
  @Roles(...NOTES_EVIDENCE_LINK_ROLES)
  async linkAlert(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() qr: QueryRunner,
    @Param("id") id: string,
    @Body() dto: LinkAlertDto,
    @CurrentUser() currentUser: AuthUserContext,
    @Req() req: Request,
  ) {
    return this.casesService.linkAlert(qr, tenantId, id, dto.alertId, currentUser, requestMeta(req));
  }
```

- [ ] **Step 4: Add alert-linking e2e tests to `apps/api/test/cases.e2e-spec.ts`**

```ts
  describe("POST /cases/:id/alerts", () => {
    it("links an existing alert, and does NOT change the alert's own status or auto-transition the case", async () => {
      const token = await tokenFor(tenantAId, UserRole.INVESTIGATOR, "link-alert");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ customerId: customer.id }).expect(201);
      const alert = await createAlert(tenantAId, customer.id);

      const res = await http()
        .post(`/cases/${created.body.data.id}/alerts`)
        .set("Authorization", `Bearer ${token}`)
        .send({ alertId: alert.id })
        .expect(201);
      expect(res.body.data.alerts).toHaveLength(1);
      expect(res.body.data.status).toBe(CaseStatus.OPEN);

      const freshAlert = await ctx.adminDataSource.getRepository(AlertEntity).findOneOrFail({ where: { id: alert.id } });
      expect(freshAlert.status).toBe(AlertStatus.NEW);
    });

    it("linking an unreviewed alert regresses a previously-satisfiable checklist item 3", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "link-regress-checklist");
      const customer = await createCustomer(tenantAId);
      const txn = await createTransaction(tenantAId, customer.id);
      const reviewedAlert = await createAlert(tenantAId, customer.id, AlertSeverity.MEDIUM, [txn.id]);
      await ctx.adminDataSource.getRepository(AlertEntity).update({ id: reviewedAlert.id }, { status: AlertStatus.ASSIGNED });
      const created = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ alertId: reviewedAlert.id }).expect(201);

      let checklist = await http().get(`/cases/${created.body.data.id}/checklist`).set("Authorization", `Bearer ${token}`).expect(200);
      expect(checklist.body.data.items.find((i: { key: string }) => i.key === "TRANSACTIONS_REVIEWED").passed).toBe(true);

      const newAlert = await createAlert(tenantAId, customer.id, AlertSeverity.MEDIUM, [txn.id]);
      await http().post(`/cases/${created.body.data.id}/alerts`).set("Authorization", `Bearer ${token}`).send({ alertId: newAlert.id }).expect(201);

      checklist = await http().get(`/cases/${created.body.data.id}/checklist`).set("Authorization", `Bearer ${token}`).expect(200);
      expect(checklist.body.data.items.find((i: { key: string }) => i.key === "TRANSACTIONS_REVIEWED").passed).toBe(false);
    });

    it("400 ALERT_CUSTOMER_MISMATCH when the alert belongs to a different customer", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "link-mismatch");
      const customer = await createCustomer(tenantAId);
      const otherCustomer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ customerId: customer.id }).expect(201);
      const alert = await createAlert(tenantAId, otherCustomer.id);

      const res = await http()
        .post(`/cases/${created.body.data.id}/alerts`)
        .set("Authorization", `Bearer ${token}`)
        .send({ alertId: alert.id })
        .expect(400);
      expect(res.body.error.code).toBe("ALERT_CUSTOMER_MISMATCH");
    });

    it("400 ALERT_ALREADY_LINKED when the alert already belongs to a case", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "link-already");
      const customer = await createCustomer(tenantAId);
      const alert = await createAlert(tenantAId, customer.id);
      const firstCase = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ alertId: alert.id }).expect(201);
      const secondCase = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ customerId: customer.id }).expect(201);

      const res = await http()
        .post(`/cases/${secondCase.body.data.id}/alerts`)
        .set("Authorization", `Bearer ${token}`)
        .send({ alertId: alert.id })
        .expect(400);
      expect(res.body.error.code).toBe("ALERT_ALREADY_LINKED");
      void firstCase;
    });

    it("400 CASE_ALREADY_TERMINAL when the case is CLOSED", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "link-terminal");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ customerId: customer.id }).expect(201);
      await ctx.adminDataSource.getRepository(CaseEntity).update({ id: created.body.data.id }, { status: CaseStatus.CLOSED });
      const alert = await createAlert(tenantAId, customer.id);

      const res = await http()
        .post(`/cases/${created.body.data.id}/alerts`)
        .set("Authorization", `Bearer ${token}`)
        .send({ alertId: alert.id })
        .expect(400);
      expect(res.body.error.code).toBe("CASE_ALREADY_TERMINAL");
    });

    it("404 ALERT_NOT_FOUND for a nonexistent alertId", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "link-not-found");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ customerId: customer.id }).expect(201);
      const res = await http()
        .post(`/cases/${created.body.data.id}/alerts`)
        .set("Authorization", `Bearer ${token}`)
        .send({ alertId: crypto.randomUUID() })
        .expect(404);
      expect(res.body.error.code).toBe("ALERT_NOT_FOUND");
    });
  });
```

- [ ] **Step 5: Run the e2e suite**

Run: `pnpm --filter api test:e2e -- cases.e2e-spec`
Expected: all PASS, including the checklist-regression assertion.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/cases apps/api/test/cases.e2e-spec.ts
git commit -m "feat(cases): add alert linking to an already-open case"
```

---

## Task 8: State machine — close/submit/approve/reject + maker-checker + Report auto-creation

**Files:**
- Create: `apps/api/src/cases/dto/close-case.dto.ts`
- Create: `apps/api/src/cases/dto/submit-case.dto.ts`
- Create: `apps/api/src/cases/dto/reject-case.dto.ts`
- Modify: `apps/api/src/cases/cases.service.ts` (add `close()`, `submit()`, `approve()`, `reject()`)
- Modify: `apps/api/src/cases/cases.controller.ts` (add `PATCH /cases/:id/close`, `/submit`, `/approve`, `/reject`)
- Modify: `apps/api/test/cases.e2e-spec.ts` (add a state-machine `describe` block)

**Interfaces:**
- Consumes: `CasesService.findEntity()`, `CasesService.computeChecklist()` (Task 6, reused verbatim as the submit-for-approval guard — "one service method, called from both places" per Section 3.6); `CaseApprovalEventEntity`, `ReportEntity` (Task 2); `CaseApprovalOutcome`, `ReportType`, `ReportStatus` (Task 1).
- Produces: `CasesService.close()`, `.submit()`, `.approve()`, `.reject()` — consumed only by the controller. `.approve()`'s `Report` row is the one Backend Prompt 7 is expected to build the rest of the Reports module against (`report.case_id`).

- [ ] **Step 1: Write the three DTOs**

`apps/api/src/cases/dto/close-case.dto.ts`:
```ts
import { IsOptional, IsString } from "class-validator";

export class CloseCaseDto {
  @IsOptional()
  @IsString()
  closureReason?: string;
}
```

`apps/api/src/cases/dto/submit-case.dto.ts`:
```ts
import { IsString } from "class-validator";

/** Non-empty-after-trim is enforced in CasesService.submit (400
 * ESCALATION_RATIONALE_REQUIRED), not here — a whitespace-only string must
 * still reach the service to get that specific error code. */
export class SubmitCaseDto {
  @IsString()
  escalationRationale!: string;
}
```

`apps/api/src/cases/dto/reject-case.dto.ts`:
```ts
import { IsString } from "class-validator";

export class RejectCaseDto {
  @IsString()
  reason!: string;
}
```

- [ ] **Step 2: Add the four transition methods to `apps/api/src/cases/cases.service.ts`**

Add `ConflictException, ForbiddenException` to the `@nestjs/common` import. Add `CaseApprovalEventEntity, ReportEntity` to the `@regops/db` import. Add `CaseApprovalOutcome, ReportStatus, ReportType` to the `@regops/shared` import.

```ts
  /** Exact string from the frontend mock's DEFAULT_CLOSURE_REASON
   * (apps/web/src/lib/mock-data/routes.ts) — Section 3.2 requires reusing it verbatim. */
  private static readonly DEFAULT_CLOSURE_REASON = "False positive — no suspicious activity confirmed after investigation.";

  /** Section 3.2: OPEN/UNDER_INVESTIGATION -> CLOSED only. COMPLIANCE_OFFICER only (role gate is on the controller). */
  async close(qr: QueryRunner, tenantId: string, caseId: string, closureReason: string | undefined, currentUser: AuthUserContext, meta: RequestMeta): Promise<CaseDetailDto> {
    const kase = await this.findEntity(qr, tenantId, caseId);
    if (kase.status !== CaseStatus.OPEN && kase.status !== CaseStatus.UNDER_INVESTIGATION) {
      throw new ConflictException({ code: "INVALID_TRANSITION", message: `Cannot close a case in status ${kase.status}.` });
    }
    const reason = closureReason?.trim() ? closureReason.trim() : CasesService.DEFAULT_CLOSURE_REASON;
    const beforeState = { status: kase.status };

    await qr.startTransaction();
    try {
      await qr.manager
        .getRepository(CaseEntity)
        .update({ id: caseId }, { status: CaseStatus.CLOSED, closedAt: new Date(), closedBy: currentUser.sub, closureReason: reason });

      await this.auditService.record(qr, {
        tenantId,
        userId: currentUser.sub,
        action: "case.closed",
        entityType: "case",
        entityId: caseId,
        beforeState,
        afterState: { status: CaseStatus.CLOSED, closureReason: reason },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      await qr.commitTransaction();
      return this.toDetail(qr, tenantId, caseId);
    } catch (err) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw err;
    }
  }

  /** Section 3.2: OPEN/UNDER_INVESTIGATION -> PENDING_APPROVAL. Enforcement
   * order matches the mock exactly: role (controller) -> separation-of-
   * duties -> checklist completeness -> rationale non-empty. */
  async submit(
    qr: QueryRunner,
    tenantId: string,
    caseId: string,
    escalationRationale: string | undefined,
    currentUser: AuthUserContext,
    meta: RequestMeta,
  ): Promise<CaseDetailDto> {
    const kase = await this.findEntity(qr, tenantId, caseId);
    if (kase.status !== CaseStatus.OPEN && kase.status !== CaseStatus.UNDER_INVESTIGATION) {
      throw new ConflictException({ code: "INVALID_TRANSITION", message: `Cannot submit a case in status ${kase.status} for approval.` });
    }
    if (currentUser.sub === kase.assignedTo) {
      throw new ForbiddenException({ code: "SUBMITTER_CANNOT_BE_ASSIGNEE", message: "The case's own assignee cannot submit it for approval." });
    }

    const checklist = await this.computeChecklist(qr, tenantId, caseId);
    if (!checklist.complete) {
      throw new BadRequestException({
        code: "ESCALATION_CHECKLIST_INCOMPLETE",
        message: "The escalation checklist is not complete.",
        details: { failedItems: checklist.items.filter((i) => !i.passed).map((i) => i.key) },
      });
    }

    const rationale = escalationRationale?.trim();
    if (!rationale) {
      throw new BadRequestException({ code: "ESCALATION_RATIONALE_REQUIRED", message: "A non-empty escalation rationale is required." });
    }

    const beforeState = { status: kase.status };
    await qr.startTransaction();
    try {
      await qr.manager.getRepository(CaseEntity).update(
        { id: caseId },
        { status: CaseStatus.PENDING_APPROVAL, submittedBy: currentUser.sub, submittedAt: new Date(), escalationRationale: rationale },
      );

      await this.auditService.record(qr, {
        tenantId,
        userId: currentUser.sub,
        action: "case.submitted_for_approval",
        entityType: "case",
        entityId: caseId,
        beforeState,
        afterState: { status: CaseStatus.PENDING_APPROVAL, escalationRationale: rationale },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      await qr.commitTransaction();
      return this.toDetail(qr, tenantId, caseId);
    } catch (err) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw err;
    }
  }

  /** Section 3.2/2.4: PENDING_APPROVAL -> SAR_FILED, in one transaction with
   * the case_approval_event row and the auto-created draft Report (report.case_id
   * is the FK Backend Prompt 7 builds the rest of the Reports module against).
   * closed_at is also set here per the schema table (Section 6): "set on
   * CLOSED or SAR_FILED" — closed_by stays null, that's the direct-close
   * path's field only. */
  async approve(qr: QueryRunner, tenantId: string, caseId: string, currentUser: AuthUserContext, meta: RequestMeta): Promise<CaseDetailDto> {
    const kase = await this.findEntity(qr, tenantId, caseId);
    if (kase.status !== CaseStatus.PENDING_APPROVAL) {
      throw new ConflictException({ code: "INVALID_TRANSITION", message: `Cannot approve a case in status ${kase.status}.` });
    }
    if (currentUser.sub === kase.submittedBy) {
      throw new ForbiddenException({ code: "APPROVER_CANNOT_BE_SUBMITTER", message: "The submitting Compliance Officer cannot also approve this case." });
    }

    const beforeState = { status: kase.status };
    const now = new Date();
    await qr.startTransaction();
    try {
      await qr.manager
        .getRepository(CaseEntity)
        .update({ id: caseId }, { status: CaseStatus.SAR_FILED, approvedBy: currentUser.sub, approvedAt: now, closedAt: now });

      const approvalRepo = qr.manager.getRepository(CaseApprovalEventEntity);
      await approvalRepo.save(
        approvalRepo.create({ tenantId, caseId, outcome: CaseApprovalOutcome.APPROVED, actor: currentUser.sub, reason: null, at: now }),
      );

      const reportRepo = qr.manager.getRepository(ReportEntity);
      await reportRepo.save(
        reportRepo.create({
          tenantId,
          caseId,
          customerId: kase.customerId,
          reportType: ReportType.SAR,
          status: ReportStatus.DRAFT,
          generatedAt: now,
          generatedBy: currentUser.sub,
        }),
      );

      await this.auditService.record(qr, {
        tenantId,
        userId: currentUser.sub,
        action: "case.approved",
        entityType: "case",
        entityId: caseId,
        beforeState,
        afterState: { status: CaseStatus.SAR_FILED },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      await qr.commitTransaction();
      return this.toDetail(qr, tenantId, caseId);
    } catch (err) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw err;
    }
  }

  /** Section 3.2: PENDING_APPROVAL -> UNDER_INVESTIGATION (never CLOSED — a
   * rejection means "needs more work," per Section 2.1's explicit decision).
   * submittedBy/submittedAt/escalationRationale are cleared so a resubmission
   * doesn't carry stale prior-submission data. */
  async reject(qr: QueryRunner, tenantId: string, caseId: string, reason: string | undefined, currentUser: AuthUserContext, meta: RequestMeta): Promise<CaseDetailDto> {
    const kase = await this.findEntity(qr, tenantId, caseId);
    if (kase.status !== CaseStatus.PENDING_APPROVAL) {
      throw new ConflictException({ code: "INVALID_TRANSITION", message: `Cannot reject a case in status ${kase.status}.` });
    }
    if (currentUser.sub === kase.submittedBy) {
      throw new ForbiddenException({ code: "APPROVER_CANNOT_BE_SUBMITTER", message: "The submitting Compliance Officer cannot also reject this case." });
    }
    const trimmedReason = reason?.trim();
    if (!trimmedReason) {
      throw new BadRequestException({ code: "REJECTION_REASON_REQUIRED", message: "A non-empty rejection reason is required." });
    }

    const beforeState = { status: kase.status };
    const now = new Date();
    await qr.startTransaction();
    try {
      await qr.manager
        .getRepository(CaseEntity)
        .update({ id: caseId }, { status: CaseStatus.UNDER_INVESTIGATION, submittedBy: null, submittedAt: null, escalationRationale: null });

      const approvalRepo = qr.manager.getRepository(CaseApprovalEventEntity);
      await approvalRepo.save(
        approvalRepo.create({ tenantId, caseId, outcome: CaseApprovalOutcome.REJECTED, actor: currentUser.sub, reason: trimmedReason, at: now }),
      );

      await this.auditService.record(qr, {
        tenantId,
        userId: currentUser.sub,
        action: "case.rejected",
        entityType: "case",
        entityId: caseId,
        beforeState,
        afterState: { status: CaseStatus.UNDER_INVESTIGATION, reason: trimmedReason },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      await qr.commitTransaction();
      return this.toDetail(qr, tenantId, caseId);
    } catch (err) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw err;
    }
  }
```

- [ ] **Step 3: Add the four endpoints to `apps/api/src/cases/cases.controller.ts`**

Add `Patch` to the `@nestjs/common` import, the three new DTO imports, and a `COMPLIANCE_OFFICER_ONLY = [UserRole.COMPLIANCE_OFFICER]` export:

```ts
  @Patch(":id/close")
  @Roles(...COMPLIANCE_OFFICER_ONLY)
  async close(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() qr: QueryRunner,
    @Param("id") id: string,
    @Body() dto: CloseCaseDto,
    @CurrentUser() currentUser: AuthUserContext,
    @Req() req: Request,
  ) {
    return this.casesService.close(qr, tenantId, id, dto.closureReason, currentUser, requestMeta(req));
  }

  @Patch(":id/submit")
  @Roles(...COMPLIANCE_OFFICER_ONLY)
  async submit(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() qr: QueryRunner,
    @Param("id") id: string,
    @Body() dto: SubmitCaseDto,
    @CurrentUser() currentUser: AuthUserContext,
    @Req() req: Request,
  ) {
    return this.casesService.submit(qr, tenantId, id, dto.escalationRationale, currentUser, requestMeta(req));
  }

  @Patch(":id/approve")
  @Roles(...COMPLIANCE_OFFICER_ONLY)
  async approve(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() qr: QueryRunner,
    @Param("id") id: string,
    @CurrentUser() currentUser: AuthUserContext,
    @Req() req: Request,
  ) {
    return this.casesService.approve(qr, tenantId, id, currentUser, requestMeta(req));
  }

  @Patch(":id/reject")
  @Roles(...COMPLIANCE_OFFICER_ONLY)
  async reject(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() qr: QueryRunner,
    @Param("id") id: string,
    @Body() dto: RejectCaseDto,
    @CurrentUser() currentUser: AuthUserContext,
    @Req() req: Request,
  ) {
    return this.casesService.reject(qr, tenantId, id, dto.reason, currentUser, requestMeta(req));
  }
```

- [ ] **Step 4: Add state-machine e2e tests to `apps/api/test/cases.e2e-spec.ts`**

Add `ReportEntity` to the `@regops/db` import. Add a shared helper that builds a checklist-complete, escalation-ready case:

```ts
  async function buildEscalatableCase(tenantId: string, creatorToken: string): Promise<{ caseId: string; assignedTo: string }> {
    const customer = await createCustomer(tenantId, { riskLevel: RiskLevel.LOW, lastRiskCalculatedAt: new Date() });
    const alert = await createAlert(tenantId, customer.id);
    await ctx.adminDataSource.getRepository(AlertEntity).update({ id: alert.id }, { status: AlertStatus.ASSIGNED });
    const created = await http().post("/cases").set("Authorization", `Bearer ${creatorToken}`).send({ alertId: alert.id }).expect(201);
    await http()
      .post(`/cases/${created.body.data.id}/notes`)
      .set("Authorization", `Bearer ${creatorToken}`)
      .send({ content: "Investigated and confirmed activity." })
      .expect(201);
    return { caseId: created.body.data.id, assignedTo: created.body.data.assignedTo };
  }
```

```ts
  describe("State machine: close/submit/approve/reject", () => {
    it("closes an OPEN case with the default closure reason when none is given", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "close-default");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ customerId: customer.id }).expect(201);

      const res = await http().patch(`/cases/${created.body.data.id}/close`).set("Authorization", `Bearer ${token}`).send({}).expect(200);
      expect(res.body.data.status).toBe(CaseStatus.CLOSED);
      expect(res.body.data.closureReason).toBe("False positive — no suspicious activity confirmed after investigation.");
      expect(res.body.data.closedBy).toBeTruthy();
    });

    it("409 INVALID_TRANSITION closing an already-CLOSED case", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "close-twice");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ customerId: customer.id }).expect(201);
      await http().patch(`/cases/${created.body.data.id}/close`).set("Authorization", `Bearer ${token}`).send({}).expect(200);

      const res = await http().patch(`/cases/${created.body.data.id}/close`).set("Authorization", `Bearer ${token}`).send({}).expect(409);
      expect(res.body.error.code).toBe("INVALID_TRANSITION");
    });

    it("403 FORBIDDEN_ROLE for INVESTIGATOR on close/submit/approve/reject (COMPLIANCE_OFFICER only)", async () => {
      const investigatorToken = await tokenFor(tenantAId, UserRole.INVESTIGATOR, "role-gate-investigator");
      const officerToken = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "role-gate-setup");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${officerToken}`).send({ customerId: customer.id }).expect(201);

      await http().patch(`/cases/${created.body.data.id}/close`).set("Authorization", `Bearer ${investigatorToken}`).send({}).expect(403);
      await http().patch(`/cases/${created.body.data.id}/submit`).set("Authorization", `Bearer ${investigatorToken}`).send({ escalationRationale: "x" }).expect(403);
      await http().patch(`/cases/${created.body.data.id}/approve`).set("Authorization", `Bearer ${investigatorToken}`).send({}).expect(403);
      await http().patch(`/cases/${created.body.data.id}/reject`).set("Authorization", `Bearer ${investigatorToken}`).send({ reason: "x" }).expect(403);
    });

    it("403 SUBMITTER_CANNOT_BE_ASSIGNEE when the case's own assignee tries to submit it", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "submit-self-assignee");
      const { caseId } = await buildEscalatableCase(tenantAId, token); // creator == assignee == token's user
      const res = await http()
        .patch(`/cases/${caseId}/submit`)
        .set("Authorization", `Bearer ${token}`)
        .send({ escalationRationale: "Escalating for SAR filing." })
        .expect(403);
      expect(res.body.error.code).toBe("SUBMITTER_CANNOT_BE_ASSIGNEE");
    });

    it("400 ESCALATION_CHECKLIST_INCOMPLETE with the specific failed item keys", async () => {
      const creatorToken = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "checklist-incomplete-creator");
      const submitterToken = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "checklist-incomplete-submitter");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${creatorToken}`).send({ customerId: customer.id }).expect(201);

      const res = await http()
        .patch(`/cases/${created.body.data.id}/submit`)
        .set("Authorization", `Bearer ${submitterToken}`)
        .send({ escalationRationale: "Escalating." })
        .expect(400);
      expect(res.body.error.code).toBe("ESCALATION_CHECKLIST_INCOMPLETE");
      expect(res.body.error.details.failedItems).toEqual(
        expect.arrayContaining(["ALERT_REVIEWED", "NOTE_ADDED"]),
      );
    });

    it("400 ESCALATION_RATIONALE_REQUIRED when the checklist passes but rationale is blank", async () => {
      const creatorToken = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "rationale-required-creator");
      const submitterToken = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "rationale-required-submitter");
      const { caseId } = await buildEscalatableCase(tenantAId, creatorToken);

      const res = await http()
        .patch(`/cases/${caseId}/submit`)
        .set("Authorization", `Bearer ${submitterToken}`)
        .send({ escalationRationale: "   " })
        .expect(400);
      expect(res.body.error.code).toBe("ESCALATION_RATIONALE_REQUIRED");
    });

    it("full maker-checker flow: submit (A) -> reject (B, reason stored, back to UNDER_INVESTIGATION) -> resubmit (B) -> approve (A) -> SAR_FILED + exactly one Report row", async () => {
      const creatorToken = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "maker-checker-creator");
      const submitterToken = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "maker-checker-submitter");
      const { caseId, assignedTo } = await buildEscalatableCase(tenantAId, creatorToken);

      // Submit as the submitter (not the assignee).
      const submitRes = await http()
        .patch(`/cases/${caseId}/submit`)
        .set("Authorization", `Bearer ${submitterToken}`)
        .send({ escalationRationale: "Confirmed suspicious structuring pattern." })
        .expect(200);
      expect(submitRes.body.data.status).toBe(CaseStatus.PENDING_APPROVAL);

      // Approve as the submitter themselves -> rejected (maker-checker gate).
      const selfApprove = await http().patch(`/cases/${caseId}/approve`).set("Authorization", `Bearer ${submitterToken}`).send({}).expect(403);
      expect(selfApprove.body.error.code).toBe("APPROVER_CANNOT_BE_SUBMITTER");

      // Reject as creatorToken — the case's own creator self-assigns at creation (Section
      // 3.1), so creatorToken's user IS `assignedTo`, and is a different Compliance
      // Officer than submitterToken, satisfying the maker-checker gate.
      expect(assignedTo).toBeTruthy();
      const rejectRes = await http()
        .patch(`/cases/${caseId}/reject`)
        .set("Authorization", `Bearer ${creatorToken}`)
        .send({ reason: "Needs a second linked transaction reviewed before filing." })
        .expect(200);
      expect(rejectRes.body.data.status).toBe(CaseStatus.UNDER_INVESTIGATION);
      expect(rejectRes.body.data.submittedBy).toBeNull();
      expect(rejectRes.body.data.submittedAt).toBeNull();
      expect(rejectRes.body.data.escalationRationale).toBeNull();

      // Resubmit (checklist is still complete — note/alert/risk state unchanged) and approve as the (different) creator/assignee.
      await http()
        .patch(`/cases/${caseId}/submit`)
        .set("Authorization", `Bearer ${submitterToken}`)
        .send({ escalationRationale: "Re-escalating after addressing the rejection." })
        .expect(200);
      const approveRes = await http().patch(`/cases/${caseId}/approve`).set("Authorization", `Bearer ${creatorToken}`).send({}).expect(200);
      expect(approveRes.body.data.status).toBe(CaseStatus.SAR_FILED);
      expect(approveRes.body.data.report).not.toBeNull();

      const reports = await ctx.adminDataSource.getRepository(ReportEntity).find({ where: { tenantId: tenantAId, caseId } });
      expect(reports).toHaveLength(1);
      expect(reports[0].customerId).toBe((await ctx.adminDataSource.getRepository(CaseEntity).findOneOrFail({ where: { id: caseId } })).customerId);

      // Cannot approve a second time — the case is already terminal.
      const doubleApprove = await http().patch(`/cases/${caseId}/approve`).set("Authorization", `Bearer ${creatorToken}`).send({}).expect(409);
      expect(doubleApprove.body.error.code).toBe("INVALID_TRANSITION");
    });

    it("400 REJECTION_REASON_REQUIRED for a blank reason", async () => {
      const creatorToken = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "reject-reason-creator");
      const submitterToken = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "reject-reason-submitter");
      const { caseId } = await buildEscalatableCase(tenantAId, creatorToken);
      await http()
        .patch(`/cases/${caseId}/submit`)
        .set("Authorization", `Bearer ${submitterToken}`)
        .send({ escalationRationale: "Escalating." })
        .expect(200);

      const res = await http().patch(`/cases/${caseId}/reject`).set("Authorization", `Bearer ${creatorToken}`).send({ reason: "  " }).expect(400);
      expect(res.body.error.code).toBe("REJECTION_REASON_REQUIRED");
    });
  });
```

- [ ] **Step 5: Run the e2e suite**

Run: `pnpm --filter api test:e2e -- cases.e2e-spec`
Expected: all PASS, including the full maker-checker round trip and the single-Report-row assertion.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/cases apps/api/test/cases.e2e-spec.ts
git commit -m "feat(cases): add close/submit/approve/reject state machine with maker-checker and Report auto-creation"
```

---

## Task 9: Reassignment endpoint

**Files:**
- Create: `apps/api/src/cases/dto/assign-case.dto.ts`
- Modify: `apps/api/src/cases/cases.service.ts` (add `assign()`)
- Modify: `apps/api/src/cases/cases.controller.ts` (add `PATCH /cases/:id/assign`)
- Modify: `apps/api/test/cases.e2e-spec.ts` (add a reassignment `describe` block)

**Interfaces:**
- Consumes: `CasesService.findEntity()` (Task 3); `CaseAssignmentEventEntity` (Task 2).
- Produces: `CasesService.assign(qr, tenantId, caseId, assignedTo, currentUser, meta): Promise<CaseDetailDto>` — consumed only by the controller. Its `case_assignment_event` rows are read by Task 11's timeline (skipping index 0, the creation-time self-assignment).

Note: Section 3.2's wording — "Reassignment... Not a status transition — can happen at any non-terminal status" — is read as an explicit guard (a case that has reached `CLOSED` or `SAR_FILED` rejects reassignment), even though the endpoint's own error list in Section 4.8 doesn't separately enumerate it. This reuses the `CASE_ALREADY_TERMINAL` code Section 3.5 already established for the same concept (a terminal case rejecting a mutation), rather than inventing a second code for the same idea.

- [ ] **Step 1: Write `apps/api/src/cases/dto/assign-case.dto.ts`**

```ts
import { IsUUID, ValidateIf } from "class-validator";

/** assignedTo is required but nullable (null = unassign) — @ValidateIf skips
 * @IsUUID() only when the value is the literal null, same pattern already
 * used for CreateCustomerDto.pepDetails' conditional validation. */
export class AssignCaseDto {
  @ValidateIf((o: AssignCaseDto) => o.assignedTo !== null)
  @IsUUID()
  assignedTo!: string | null;
}
```

- [ ] **Step 2: Add `assign()` to `apps/api/src/cases/cases.service.ts`**

```ts
  /** Section 3.2/4.8 — not a status transition, but rejected on an already-
   * terminal case (see this task's note above). */
  async assign(
    qr: QueryRunner,
    tenantId: string,
    caseId: string,
    assignedTo: string | null,
    currentUser: AuthUserContext,
    meta: RequestMeta,
  ): Promise<CaseDetailDto> {
    const kase = await this.findEntity(qr, tenantId, caseId);
    if (kase.status === CaseStatus.CLOSED || kase.status === CaseStatus.SAR_FILED) {
      throw new BadRequestException({ code: "CASE_ALREADY_TERMINAL", message: "Cannot reassign a closed or filed case." });
    }

    const beforeState = { assignedTo: kase.assignedTo };
    const now = new Date();

    await qr.startTransaction();
    try {
      await qr.manager.getRepository(CaseEntity).update({ id: caseId }, { assignedTo });

      const assignmentRepo = qr.manager.getRepository(CaseAssignmentEventEntity);
      await assignmentRepo.save(assignmentRepo.create({ tenantId, caseId, assignedTo, assignedBy: currentUser.sub, at: now }));

      await this.auditService.record(qr, {
        tenantId,
        userId: currentUser.sub,
        action: "case.reassigned",
        entityType: "case",
        entityId: caseId,
        beforeState,
        afterState: { assignedTo },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      await qr.commitTransaction();
      return this.toDetail(qr, tenantId, caseId);
    } catch (err) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw err;
    }
  }
```

- [ ] **Step 3: Add the endpoint to `apps/api/src/cases/cases.controller.ts`**

Add the `AssignCaseDto` import and an `ASSIGN_ROLES = [UserRole.COMPLIANCE_OFFICER, UserRole.TENANT_ADMIN]` export:

```ts
  @Patch(":id/assign")
  @Roles(...ASSIGN_ROLES)
  async assign(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() qr: QueryRunner,
    @Param("id") id: string,
    @Body() dto: AssignCaseDto,
    @CurrentUser() currentUser: AuthUserContext,
    @Req() req: Request,
  ) {
    return this.casesService.assign(qr, tenantId, id, dto.assignedTo, currentUser, requestMeta(req));
  }
```

- [ ] **Step 4: Add reassignment e2e tests to `apps/api/test/cases.e2e-spec.ts`**

```ts
  describe("PATCH /cases/:id/assign", () => {
    it("reassigns the case and records a case_assignment_event row (index 1, after creation's index 0)", async () => {
      const officerToken = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "assign-officer");
      const { user: newAssignee } = await createUserFixture(ctx.adminDataSource, tenantAId, { email: "assign-target@test.dev", role: UserRole.INVESTIGATOR });
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${officerToken}`).send({ customerId: customer.id }).expect(201);

      const res = await http()
        .patch(`/cases/${created.body.data.id}/assign`)
        .set("Authorization", `Bearer ${officerToken}`)
        .send({ assignedTo: newAssignee.id })
        .expect(200);
      expect(res.body.data.assignedTo).toBe(newAssignee.id);

      const events = await ctx.adminDataSource
        .getRepository(CaseAssignmentEventEntity)
        .find({ where: { tenantId: tenantAId, caseId: created.body.data.id }, order: { at: "ASC" } });
      expect(events).toHaveLength(2);
      expect(events[1].assignedTo).toBe(newAssignee.id);
    });

    it("unassigns with assignedTo: null", async () => {
      const officerToken = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "assign-unassign");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${officerToken}`).send({ customerId: customer.id }).expect(201);

      const res = await http()
        .patch(`/cases/${created.body.data.id}/assign`)
        .set("Authorization", `Bearer ${officerToken}`)
        .send({ assignedTo: null })
        .expect(200);
      expect(res.body.data.assignedTo).toBeNull();
    });

    it("TENANT_ADMIN can reassign; INVESTIGATOR and VIEWER cannot (403)", async () => {
      const officerToken = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "assign-setup");
      const adminToken = await tokenFor(tenantAId, UserRole.TENANT_ADMIN, "assign-admin");
      const investigatorToken = await tokenFor(tenantAId, UserRole.INVESTIGATOR, "assign-investigator");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${officerToken}`).send({ customerId: customer.id }).expect(201);

      await http().patch(`/cases/${created.body.data.id}/assign`).set("Authorization", `Bearer ${adminToken}`).send({ assignedTo: null }).expect(200);
      await http().patch(`/cases/${created.body.data.id}/assign`).set("Authorization", `Bearer ${investigatorToken}`).send({ assignedTo: null }).expect(403);
    });

    it("400 CASE_ALREADY_TERMINAL on a CLOSED case", async () => {
      const officerToken = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "assign-terminal");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${officerToken}`).send({ customerId: customer.id }).expect(201);
      await http().patch(`/cases/${created.body.data.id}/close`).set("Authorization", `Bearer ${officerToken}`).send({}).expect(200);

      const res = await http()
        .patch(`/cases/${created.body.data.id}/assign`)
        .set("Authorization", `Bearer ${officerToken}`)
        .send({ assignedTo: null })
        .expect(400);
      expect(res.body.error.code).toBe("CASE_ALREADY_TERMINAL");
    });
  });
```

- [ ] **Step 5: Run the e2e suite**

Run: `pnpm --filter api test:e2e -- cases.e2e-spec`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/cases apps/api/test/cases.e2e-spec.ts
git commit -m "feat(cases): add case reassignment endpoint"
```

---

## Task 10: AlertsService status-change events + Cases auto-transition listener (trigger #3)

**Files:**
- Modify: `apps/api/src/rules/alerts/alerts.service.ts` (emit `ALERT_EVENTS.STATUS_CHANGED` from `assign()`; add `previousStatus` to the existing `ALERT_EVENTS.CLOSED` emission from `close()`)
- Create: `apps/api/src/cases/listeners/alert-status.listener.ts`
- Modify: `apps/api/src/cases/cases.module.ts` (register `AlertStatusListener` as a provider)
- Modify: `apps/api/test/cases.e2e-spec.ts` (add a listener e2e block)

**Interfaces:**
- Consumes: `ALERT_EVENTS.STATUS_CHANGED`, `AlertStatusChangedEvent`, extended `AlertClosedEvent` (Task 1); `CasesService.maybeStartInvestigation()` (Task 4); `CaseAlertEntity` (Task 2).
- Produces: nothing new consumed by later tasks — this closes out all three of Section 3.2's auto-transition triggers (note added: Task 4; evidence uploaded: Task 5; linked alert status changes off NEW: this task).

Today, `AlertsService` only changes an alert's `status` in two places: `assign()` (`NEW` -> `ASSIGNED`) and `close()` (any -> `CLOSED`, already emitting `ALERT_EVENTS.CLOSED`, verified by grep — no other status mutation and no existing subscriber of any `ALERT_EVENTS.*` exists anywhere in `apps/api/src` today, so extending `AlertClosedEvent`'s payload is purely additive and safe).

- [ ] **Step 1: Modify `apps/api/src/rules/alerts/alerts.service.ts`'s `assign()` method**

Replace:
```ts
    const beforeState = { status: alert.status, assignedTo: alert.assignedTo };
    alert.assignedTo = assignedTo;
    if (alert.status === AlertStatus.NEW) alert.status = AlertStatus.ASSIGNED;
    const saved = await qr.manager.getRepository(AlertEntity).save(alert);
```
with:
```ts
    const beforeState = { status: alert.status, assignedTo: alert.assignedTo };
    const previousStatus = alert.status;
    alert.assignedTo = assignedTo;
    if (alert.status === AlertStatus.NEW) alert.status = AlertStatus.ASSIGNED;
    const saved = await qr.manager.getRepository(AlertEntity).save(alert);
```

And immediately after the existing `await this.auditService.record(qr, {...});` call in `assign()` (before its final `return this.toDto(saved);`), add:

```ts
    // Backend Prompt 6: Case Management's auto-transition-to-UNDER_INVESTIGATION
    // trigger listens for this — only emit when the status genuinely changed.
    if (saved.status !== previousStatus) {
      this.eventEmitter.emit(ALERT_EVENTS.STATUS_CHANGED, {
        tenantId,
        alertId: saved.id,
        customerId: saved.customerId,
        previousStatus,
        newStatus: saved.status,
      });
    }
```

- [ ] **Step 2: Modify `apps/api/src/rules/alerts/alerts.service.ts`'s `close()` method**

Replace:
```ts
    const beforeState = { status: alert.status };
    alert.status = AlertStatus.CLOSED;
```
with:
```ts
    const beforeState = { status: alert.status };
    const previousStatus = alert.status;
    alert.status = AlertStatus.CLOSED;
```

And add `previousStatus` to the existing emit call:
```ts
    this.eventEmitter.emit(ALERT_EVENTS.CLOSED, {
      tenantId,
      alertId: saved.id,
      closedBy: currentUser.sub,
      closeCategory,
      previousStatus,
    });
```

- [ ] **Step 3: Write `apps/api/src/cases/listeners/alert-status.listener.ts`**

```ts
import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { DataSource, QueryRunner } from "typeorm";
import { CaseAlertEntity } from "@regops/db";
import { AlertStatus } from "@regops/shared";
import { AlertClosedEvent, AlertStatusChangedEvent } from "../../rules/rules.events";
import { CasesService } from "../cases.service";

/**
 * Section 3.2: "a linked alert's own status changes away from NEW ... this
 * module needs to react to that, not just to actions taken within Cases
 * itself. Implement as a listener/subscriber on whatever event the Alerts
 * module already emits" — same event-driven cross-module pattern as
 * RiskModule's TransactionListener (@OnEvent("transaction.ingested")).
 * Listens to BOTH alert.status_changed (Task 10 addition, emitted by
 * AlertsService.assign) and alert.closed (existing since Prompt 5, now
 * carrying previousStatus) since either event can be the transition that
 * moved a linked alert off NEW.
 */
@Injectable()
export class AlertStatusListener {
  private readonly logger = new Logger(AlertStatusListener.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly casesService: CasesService,
  ) {}

  @OnEvent("alert.status_changed")
  async onAlertStatusChanged(event: AlertStatusChangedEvent): Promise<void> {
    await this.handle(event.tenantId, event.alertId, event.previousStatus);
  }

  @OnEvent("alert.closed")
  async onAlertClosed(event: AlertClosedEvent): Promise<void> {
    await this.handle(event.tenantId, event.alertId, event.previousStatus);
  }

  private async handle(tenantId: string, alertId: string, previousStatus: AlertStatus): Promise<void> {
    if (previousStatus !== AlertStatus.NEW) return; // only a move OFF NEW is investigative activity

    try {
      await this.withTenantContext(tenantId, async (qr) => {
        const link = await qr.manager.getRepository(CaseAlertEntity).findOne({ where: { tenantId, alertId } });
        if (!link) return; // this alert isn't linked to any case — nothing to transition
        await this.casesService.maybeStartInvestigation(qr, tenantId, link.caseId);
      });
    } catch (err) {
      this.logger.error(`Failed to process alert status change for case auto-transition (alert ${alertId})`, err as Error);
    }
  }

  /** Same shape as RiskModule's TransactionListener.withTenantContext — never
   * app.bypass_rls, confined to exactly the tenant this event names. */
  private async withTenantContext<T>(tenantId: string, fn: (qr: QueryRunner) => Promise<T>): Promise<T> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await qr.query(`SELECT set_config('app.current_tenant_id', $1, true), set_config('app.bypass_rls', 'false', true)`, [tenantId]);
      const result = await fn(qr);
      await qr.commitTransaction();
      return result;
    } catch (err) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }
}
```

- [ ] **Step 4: Register `AlertStatusListener` in `apps/api/src/cases/cases.module.ts`**

Add to `providers` (not `exports` — it's a pure event subscriber, same convention as `TransactionListener`/`CustomerListener` in their own modules).

- [ ] **Step 5: Add listener e2e tests to `apps/api/test/cases.e2e-spec.ts`**

```ts
  describe("Alert status-change auto-transition (via the existing Alerts module)", () => {
    it("PATCH /alerts/:id/assign on a linked NEW alert transitions its OPEN case to UNDER_INVESTIGATION", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "listener-assign");
      const customer = await createCustomer(tenantAId);
      const alert = await createAlert(tenantAId, customer.id);
      const created = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ alertId: alert.id }).expect(201);
      expect(created.body.data.status).toBe(CaseStatus.OPEN);

      const { user: assignee } = await createUserFixture(ctx.adminDataSource, tenantAId, { email: "listener-assignee@test.dev", role: UserRole.INVESTIGATOR });
      await http().post(`/alerts/${alert.id}/assign`).set("Authorization", `Bearer ${token}`).send({ assignedTo: assignee.id }).expect(201);

      // The listener runs asynchronously off the event emitter — poll briefly for the transition.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const detail = await http().get(`/cases/${created.body.data.id}`).set("Authorization", `Bearer ${token}`).expect(200);
      expect(detail.body.data.status).toBe(CaseStatus.UNDER_INVESTIGATION);
    });

    it("PATCH /alerts/:id/close on a linked NEW alert also transitions its OPEN case to UNDER_INVESTIGATION", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "listener-close");
      const customer = await createCustomer(tenantAId);
      const alert = await createAlert(tenantAId, customer.id);
      const created = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ alertId: alert.id }).expect(201);

      await http()
        .post(`/alerts/${alert.id}/close`)
        .set("Authorization", `Bearer ${token}`)
        .send({ category: "FALSE_POSITIVE", reason: "Not suspicious." })
        .expect(201);

      await new Promise((resolve) => setTimeout(resolve, 300));
      const detail = await http().get(`/cases/${created.body.data.id}`).set("Authorization", `Bearer ${token}`).expect(200);
      expect(detail.body.data.status).toBe(CaseStatus.UNDER_INVESTIGATION);
    });

    it("does not touch a case whose linked alert isn't the one that changed status", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "listener-unrelated");
      const customer = await createCustomer(tenantAId);
      const linkedAlert = await createAlert(tenantAId, customer.id);
      const unrelatedAlert = await createAlert(tenantAId, customer.id);
      const created = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ alertId: linkedAlert.id }).expect(201);

      const { user: assignee } = await createUserFixture(ctx.adminDataSource, tenantAId, { email: "listener-unrelated-assignee@test.dev", role: UserRole.INVESTIGATOR });
      await http().post(`/alerts/${unrelatedAlert.id}/assign`).set("Authorization", `Bearer ${token}`).send({ assignedTo: assignee.id }).expect(201);

      await new Promise((resolve) => setTimeout(resolve, 300));
      const detail = await http().get(`/cases/${created.body.data.id}`).set("Authorization", `Bearer ${token}`).expect(200);
      expect(detail.body.data.status).toBe(CaseStatus.OPEN);
    });
  });
```

- [ ] **Step 6: Run the full suite (Rules/Alerts + Cases)**

Run: `pnpm --filter api test:e2e -- rules.e2e-spec cases.e2e-spec`
Expected: all PASS — `rules.e2e-spec.ts`'s existing alert-assign/close tests still pass unchanged (the new event emissions are additive, no existing behavior changed), and the three new listener tests in `cases.e2e-spec.ts` pass.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/rules/alerts/alerts.service.ts apps/api/src/cases apps/api/test/cases.e2e-spec.ts
git commit -m "feat(cases): auto-transition to UNDER_INVESTIGATION when a linked alert's status changes off NEW"
```

---

## Task 11: Timeline assembly service

**Files:**
- Create: `apps/api/src/cases/case-timeline.service.ts`
- Modify: `apps/api/src/cases/cases.service.ts` (inject `CaseTimelineService` via `forwardRef`, replace `toDetail()`'s `timeline: []` line)
- Modify: `apps/api/src/cases/cases.module.ts` (register `CaseTimelineService`)
- Modify: `apps/api/test/cases.e2e-spec.ts` (add a full-lifecycle timeline `describe` block)

**Interfaces:**
- Consumes: `CasesService.listNotes()`, `.listEvidence()`, `.getDerivedTransactions()` (Tasks 4/5/6); `CaseAssignmentEventEntity`, `CaseApprovalEventEntity`, `CaseAlertEntity` (Task 2).
- Produces: `CaseTimelineService.build(qr, tenantId, kase): Promise<CaseTimelineEventDto[]>` — consumed by `CasesService.toDetail()`, the last of the five lines that method's Task 3 version stubbed.

`CaseTimelineService` needs read-only helpers already living on `CasesService` (`listNotes`/`listEvidence`/`getDerivedTransactions`), and `CasesService.toDetail()` needs `CaseTimelineService.build()` — a genuine mutual dependency, resolved with NestJS's standard `forwardRef()` pattern (not by duplicating the helpers a second time, which is what Tasks 4/5/6 did to *avoid* introducing this exact circularity for simpler single-method cases; a 9-event-type assembler is worth its own file per Section 7's module structure, so this task resolves the cycle properly instead of dodging it).

- [ ] **Step 1: Confirm the mock's exact literal strings this task must reproduce**

Already sourced directly from `apps/web/src/app/(app)/cases/[id]/page.tsx` and `apps/web/src/lib/mock-data/format.ts` while writing this plan:
- Opened (0 alerts): `"Opened this case."`
- Opened (1 alert): `` `Opened this case from alert "${title}".` ``
- Opened (2+ alerts): `` `Opened this case, linked to ${count} alerts: ${titles.join(", ")}.` `` (titles individually quoted)
- Reassigned: `` `Reassigned this case to ${assignedTo}.` `` or `"Unassigned this case."`
- Transaction: `` `${humanizeEnum(type)} transaction — ${narration}, ${formatNGN(amount)} via ${humanizeEnum(channel)}.` ``
- Closed (false positive): `` `Closed this case as a false positive.${closureReason ? ` ${closureReason}` : ""}` ``
- SAR terminal event: `"Approved and escalated this case for SAR filing."` (Section 3.8 item 9's own literal wording — used instead of the mock's near-identical "Escalated and approved..." since Section 3.8 states this text directly)
- `humanizeEnum("CREDIT")` -> `"Credit"`; `formatNGN` -> `Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", maximumFractionDigits: 0 }).format(Number(amount))`

Note: unlike the mock, `text` embeds raw user ids (e.g. `Reassigned this case to a1b2c3-...`) rather than a resolved display name — this backend has no user-name-resolution helper anywhere (`AuditLog`, `CaseNoteDto.userId`, `AlertDto.assignedTo` etc. all store raw ids too), so the consuming frontend is expected to resolve ids to names itself from its own already-fetched `/users` list, exactly as the mock's `buildTimeline` does with its separately-fetched `users` array.

- [ ] **Step 2: Write `apps/api/src/cases/case-timeline.service.ts`**

```ts
import { forwardRef, Inject, Injectable } from "@nestjs/common";
import { QueryRunner } from "typeorm";
import { AlertEntity, CaseApprovalEventEntity, CaseAlertEntity, CaseAssignmentEventEntity, CaseEntity } from "@regops/db";
import { CaseApprovalOutcome, CaseStatus, CaseTimelineEventDto } from "@regops/shared";
import { CasesService } from "./cases.service";

/** "UNDER_REVIEW" -> "Under Review" — same shape as the mock's humanizeEnum (format.ts). */
function humanizeEnum(value: string): string {
  return value
    .split("_")
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(" ");
}

/** Same shape as the mock's formatNGN (format.ts). */
function formatNGN(amount: number | string): string {
  return new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", maximumFractionDigits: 0 }).format(Number(amount));
}

@Injectable()
export class CaseTimelineService {
  constructor(
    @Inject(forwardRef(() => CasesService))
    private readonly casesService: CasesService,
  ) {}

  /** Section 3.8 — exact event list, sorted chronologically by `at`. */
  async build(qr: QueryRunner, tenantId: string, kase: CaseEntity): Promise<CaseTimelineEventDto[]> {
    const events: CaseTimelineEventDto[] = [];

    const caseAlerts = await qr.manager.getRepository(CaseAlertEntity).find({ where: { tenantId, caseId: kase.id } });
    const alertIds = caseAlerts.map((ca) => ca.alertId);
    const alerts = alertIds.length
      ? await qr.manager
          .getRepository(AlertEntity)
          .createQueryBuilder("a")
          .where("a.tenant_id = :tenantId", { tenantId })
          .andWhere("a.id IN (:...alertIds)", { alertIds })
          .getMany()
      : [];
    const alertById = new Map(alerts.map((a) => [a.id, a]));

    // 1. Opened — alerts whose linked_at exactly equals case.created_at were
    // part of the creation payload (see CasesService.create's docblock on
    // why they share one `now`); anything later is a genuine post-creation link (event 5).
    const creationTimeLinks = caseAlerts.filter((ca) => ca.linkedAt.getTime() === kase.createdAt.getTime());
    const creationTimeTitles = creationTimeLinks.map((ca) => alertById.get(ca.alertId)?.title).filter((t): t is string => Boolean(t));
    events.push({ type: "opened", at: kase.createdAt.toISOString(), actor: kase.createdBy, text: this.openedText(creationTimeTitles) });

    // 2. Reassigned — index 1+ only (index 0 is the creation self-assignment).
    const assignmentEvents = await qr.manager
      .getRepository(CaseAssignmentEventEntity)
      .find({ where: { tenantId, caseId: kase.id }, order: { at: "ASC" } });
    for (const ev of assignmentEvents.slice(1)) {
      events.push({
        type: "reassigned",
        at: ev.at.toISOString(),
        actor: ev.assignedBy,
        text: ev.assignedTo ? `Reassigned this case to ${ev.assignedTo}.` : "Unassigned this case.",
      });
    }

    // 3. Note added
    const notes = await this.casesService.listNotes(qr, tenantId, kase.id);
    for (const note of notes) {
      events.push({ type: "note", at: note.createdAt, actor: note.userId, text: note.content });
    }

    // 4. Evidence uploaded — Section 2.6's fix (the mock omits this entirely).
    const evidence = await this.casesService.listEvidence(qr, tenantId, kase.id);
    for (const e of evidence) {
      events.push({ type: "evidence", at: e.createdAt, actor: e.uploadedBy, text: `Uploaded evidence: "${e.fileName}".` });
    }

    // 5. Alert linked — case_alert rows linked strictly AFTER creation only.
    for (const ca of caseAlerts) {
      if (ca.linkedAt.getTime() <= kase.createdAt.getTime()) continue;
      const alert = alertById.get(ca.alertId);
      events.push({
        type: "alert_linked",
        at: ca.linkedAt.toISOString(),
        actor: ca.linkedBy,
        text: `Linked alert "${alert?.title ?? ca.alertId}" to this case.`,
      });
    }

    // 6. Transaction — actor is always the literal "system", never a user.
    const transactions = await this.casesService.getDerivedTransactions(qr, tenantId, kase.id);
    for (const t of transactions) {
      events.push({
        type: "transaction",
        at: t.occurredAt,
        actor: "system",
        text: `${humanizeEnum(t.type)} transaction — ${t.narration ?? "No narration"}, ${formatNGN(t.amount)} via ${humanizeEnum(t.channel)}.`,
      });
    }

    // 7. Submitted for approval
    if (kase.submittedAt && kase.submittedBy) {
      events.push({
        type: "submitted",
        at: kase.submittedAt.toISOString(),
        actor: kase.submittedBy,
        text: "Submitted this case for SAR-escalation approval.",
      });
    }

    // 8. Approved / Rejected
    const approvalEvents = await qr.manager
      .getRepository(CaseApprovalEventEntity)
      .find({ where: { tenantId, caseId: kase.id }, order: { at: "ASC" } });
    for (const ev of approvalEvents) {
      events.push({
        type: ev.outcome === CaseApprovalOutcome.APPROVED ? "approved" : "rejected",
        at: ev.at.toISOString(),
        actor: ev.actor,
        text:
          ev.outcome === CaseApprovalOutcome.APPROVED
            ? "Approved this case's SAR escalation request."
            : `Rejected this case's SAR escalation request. ${ev.reason ?? ""}`.trim(),
      });
    }

    // 9. Terminal event — mutually exclusive: a case is either CLOSED (direct close path,
    // closed_at set but status CLOSED) or SAR_FILED (approval path, closed_at ALSO set —
    // Section 6's schema table — but status is SAR_FILED, not CLOSED).
    if (kase.closedAt && kase.status === CaseStatus.CLOSED) {
      events.push({
        type: "closed",
        at: kase.closedAt.toISOString(),
        actor: kase.closedBy ?? "system",
        text: `Closed this case as a false positive.${kase.closureReason ? ` ${kase.closureReason}` : ""}`,
      });
    } else if (kase.approvedAt && kase.approvedBy) {
      events.push({
        type: "sar_filed",
        at: kase.approvedAt.toISOString(),
        actor: kase.approvedBy,
        text: "Approved and escalated this case for SAR filing.",
      });
    }

    return events.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  }

  private openedText(creationTimeAlertTitles: string[]): string {
    if (creationTimeAlertTitles.length === 0) return "Opened this case.";
    if (creationTimeAlertTitles.length === 1) return `Opened this case from alert "${creationTimeAlertTitles[0]}".`;
    const titles = creationTimeAlertTitles.map((t) => `"${t}"`).join(", ");
    return `Opened this case, linked to ${creationTimeAlertTitles.length} alerts: ${titles}.`;
  }
}
```

- [ ] **Step 3: Wire `CaseTimelineService` into `apps/api/src/cases/cases.service.ts`**

Add `forwardRef, Inject` to the `@nestjs/common` import. Change the constructor:

```ts
  constructor(
    private readonly auditService: AuditService,
    @Inject(forwardRef(() => CaseTimelineService))
    private readonly caseTimelineService: CaseTimelineService,
  ) {}
```

Add the `CaseTimelineService` import (from `./case-timeline.service`). Replace `toDetail()`'s `timeline: []` line:

```ts
      timeline: await this.caseTimelineService.build(qr, tenantId, kase),
```

- [ ] **Step 4: Register `CaseTimelineService` in `apps/api/src/cases/cases.module.ts`**

Add to both `providers` and `exports`.

- [ ] **Step 5: Add full-lifecycle timeline e2e tests to `apps/api/test/cases.e2e-spec.ts`**

```ts
  describe("Timeline assembly", () => {
    it("assembles opened/reassigned/note/evidence/alert_linked/transaction/submitted/approved/sar_filed in chronological order", async () => {
      const creatorToken = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "timeline-creator");
      const submitterToken = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "timeline-submitter");
      const customer = await createCustomer(tenantAId, { riskLevel: RiskLevel.LOW, lastRiskCalculatedAt: new Date() });
      const txn = await createTransaction(tenantAId, customer.id, { narration: "Salary payment" });
      const originalAlert = await createAlert(tenantAId, customer.id, AlertSeverity.MEDIUM, [txn.id]);

      const created = await http().post("/cases").set("Authorization", `Bearer ${creatorToken}`).send({ alertId: originalAlert.id }).expect(201);
      const caseId = created.body.data.id;

      const { user: newAssignee } = await createUserFixture(ctx.adminDataSource, tenantAId, { email: "timeline-assignee@test.dev", role: UserRole.INVESTIGATOR });
      await http().patch(`/cases/${caseId}/assign`).set("Authorization", `Bearer ${creatorToken}`).send({ assignedTo: newAssignee.id }).expect(200);
      await http().post(`/cases/${caseId}/notes`).set("Authorization", `Bearer ${creatorToken}`).send({ content: "Reviewed the flagged transaction." }).expect(201);
      await http()
        .post(`/cases/${caseId}/evidence`)
        .set("Authorization", `Bearer ${creatorToken}`)
        .attach("file", Buffer.from("evidence,csv,data"), { filename: "notes.csv", contentType: "text/csv" })
        .expect(201);
      const secondAlert = await createAlert(tenantAId, customer.id, AlertSeverity.MEDIUM, [txn.id]);
      await http().post(`/cases/${caseId}/alerts`).set("Authorization", `Bearer ${creatorToken}`).send({ alertId: secondAlert.id }).expect(201);
      await ctx.adminDataSource.getRepository(AlertEntity).update({ id: originalAlert.id }, { status: AlertStatus.ASSIGNED });
      await ctx.adminDataSource.getRepository(AlertEntity).update({ id: secondAlert.id }, { status: AlertStatus.ASSIGNED });

      await http()
        .patch(`/cases/${caseId}/submit`)
        .set("Authorization", `Bearer ${submitterToken}`)
        .send({ escalationRationale: "Confirmed pattern across both alerts." })
        .expect(200);
      await http().patch(`/cases/${caseId}/approve`).set("Authorization", `Bearer ${creatorToken}`).send({}).expect(200);

      const detail = await http().get(`/cases/${caseId}`).set("Authorization", `Bearer ${creatorToken}`).expect(200);
      const timeline: { type: string; at: string; actor: string; text: string }[] = detail.body.data.timeline;

      // Exactly one "opened" (naming the creation-time alert), one "reassigned"
      // (not two — index 0 is skipped), one "note", one "evidence", one
      // "alert_linked" (only the post-creation link, not the creation-time one),
      // one "transaction", one "submitted", one "approved", one "sar_filed".
      const typeCounts = timeline.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.type]: (acc[e.type] ?? 0) + 1 }), {});
      expect(typeCounts).toEqual({
        opened: 1,
        reassigned: 1,
        note: 1,
        evidence: 1,
        alert_linked: 1,
        transaction: 1,
        submitted: 1,
        approved: 1,
        sar_filed: 1,
      });

      expect(timeline[0].type).toBe("opened");
      expect(timeline[0].text).toBe(`Opened this case from alert "${originalAlert.title}".`);
      expect(timeline.find((e) => e.type === "alert_linked")!.text).toBe(`Linked alert "${secondAlert.title}" to this case.`);
      expect(timeline.find((e) => e.type === "transaction")!.text).toBe(`Credit transaction — Salary payment, ₦50,000 via Mobile.`);
      expect(timeline.find((e) => e.type === "sar_filed")!.text).toBe("Approved and escalated this case for SAR filing.");

      // Chronological order end-to-end.
      const timestamps = timeline.map((e) => new Date(e.at).getTime());
      expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
    });

    it("a rejected-then-closed case shows a 'rejected' event (with reason) and a 'closed' terminal event, not 'sar_filed'", async () => {
      const creatorToken = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "timeline-reject-close-creator");
      const submitterToken = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "timeline-reject-close-submitter");
      const customer = await createCustomer(tenantAId, { riskLevel: RiskLevel.LOW, lastRiskCalculatedAt: new Date() });
      const alert = await createAlert(tenantAId, customer.id);
      await ctx.adminDataSource.getRepository(AlertEntity).update({ id: alert.id }, { status: AlertStatus.ASSIGNED });
      const created = await http().post("/cases").set("Authorization", `Bearer ${creatorToken}`).send({ alertId: alert.id }).expect(201);
      await http().post(`/cases/${created.body.data.id}/notes`).set("Authorization", `Bearer ${creatorToken}`).send({ content: "note" }).expect(201);

      await http()
        .patch(`/cases/${created.body.data.id}/submit`)
        .set("Authorization", `Bearer ${submitterToken}`)
        .send({ escalationRationale: "x" })
        .expect(200);
      await http()
        .patch(`/cases/${created.body.data.id}/reject`)
        .set("Authorization", `Bearer ${creatorToken}`)
        .send({ reason: "Not enough evidence yet." })
        .expect(200);
      await http().patch(`/cases/${created.body.data.id}/close`).set("Authorization", `Bearer ${creatorToken}`).send({}).expect(200);

      const detail = await http().get(`/cases/${created.body.data.id}`).set("Authorization", `Bearer ${creatorToken}`).expect(200);
      const timeline: { type: string; text: string }[] = detail.body.data.timeline;
      expect(timeline.some((e) => e.type === "sar_filed")).toBe(false);
      expect(timeline.find((e) => e.type === "rejected")!.text).toContain("Not enough evidence yet.");
      expect(timeline.find((e) => e.type === "closed")).toBeTruthy();
    });
  });
```

- [ ] **Step 6: Run the e2e suite**

Run: `pnpm --filter api test:e2e -- cases.e2e-spec`
Expected: all PASS, including exact type-count and text assertions.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/cases apps/api/test/cases.e2e-spec.ts
git commit -m "feat(cases): add full timeline assembly (opened/reassigned/note/evidence/alert-linked/transaction/submitted/approved-rejected/terminal)"
```

---

## Task 12: RLS-at-DB-level test, full verification, and HANDOFF.md update

**Files:**
- Modify: `apps/api/test/cases.e2e-spec.ts` (add an RLS-at-database-level `describe` block)
- Modify: `HANDOFF.md` (append the Backend Prompt 6 section)

**Interfaces:**
- Consumes: everything from Tasks 1-11. This task adds no new production code — it is pure verification plus documentation.

- [ ] **Step 1: Add an RLS-at-the-database-level test to `apps/api/test/cases.e2e-spec.ts`**

Same technique Backend Prompt 4 used to catch the partition-RLS gap (`transactions.e2e-spec.ts`'s "RLS enforced at the partition level" block) — connect as `regops_app` (no bypass) with **no** `set_config` at all, and confirm a raw query against `"case"` returns zero rows even though a real row exists.

```ts
  describe("RLS enforced at the database level (not just application-level tenant filtering)", () => {
    it("querying \"case\" directly under regops_app with no tenant context set returns 0 rows", async () => {
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, "rls-direct");
      const customer = await createCustomer(tenantAId);
      const created = await http().post("/cases").set("Authorization", `Bearer ${token}`).send({ customerId: customer.id }).expect(201);

      const rawAppDataSource = new DataSource({ type: "postgres", url: process.env.DATABASE_URL, entities: [] });
      await rawAppDataSource.initialize();
      try {
        const qr = rawAppDataSource.createQueryRunner();
        await qr.connect();
        try {
          // No set_config at all — a connection with no tenant context whatsoever.
          const rows = await qr.query(`SELECT * FROM "case" WHERE id = $1`, [created.body.data.id]);
          expect(rows).toHaveLength(0);
        } finally {
          await qr.release();
        }
      } finally {
        await rawAppDataSource.destroy();
      }
    });
  });
```

- [ ] **Step 2: Run the full workspace verification suite**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e`
Expected: all green across every workspace package (`api`, `config`, `db`, `file-storage`, `risk-engine`, `rules-engine`, `screening-engine`, `shared`, `web`, `worker`), including the full `apps/api` e2e suite (every existing suite plus the new `cases.e2e-spec.ts`). Record the actual total e2e count (existing count + however many new `cases.e2e-spec.ts` tests were written across Tasks 3-12) — do not guess this number ahead of actually running the suite.

- [ ] **Step 3: Update `HANDOFF.md`**

Append a new section after the existing Backend Prompt 5 content (after its "Second follow-up session" paragraph, i.e. at the current end of the file), following the file's own established structure exactly (a narrative "adds" section, a "Deviations" numbered list, additions to "Known issues", and a "Definition of Done" table with a bottom-line paragraph — matching every prior prompt's section shape).

```markdown

### Backend Prompt 6 (Case Management module) adds

- **`packages/shared`**: `CaseStatus`/`CasePriority`/`CaseApprovalOutcome`/`ReportType`/`ReportStatus`
  enums; `CaseDto`/`CaseCustomerSummaryDto`/`CaseAlertSummaryDto`/`CaseNoteDto`/`CaseEvidenceDto`/
  `CaseChecklistItemDto`/`CaseChecklistDto`/`CaseTimelineEventDto`/`CaseReportSummaryDto`/
  `CaseDetailDto`/`CaseListItemDto`/`ReportDto` wire types. `ALERT_EVENTS.STATUS_CHANGED` and
  `AlertStatusChangedEvent` added to `rules.events.ts`; `AlertClosedEvent` gained a `previousStatus`
  field — both needed so Cases can react to a linked alert moving off `NEW` (Section 3.2's third
  auto-transition trigger) without Prompt 5's `AlertsService` needing to know Cases exists.
- **`packages/db`**: `CaseEntity`, `CaseAlertEntity`, `CaseAssignmentEventEntity`, `CaseNoteEntity`,
  `CaseEvidenceEntity`, `CaseApprovalEventEntity`, `ReportEntity`; migration `1700000060000-Cases.ts`
  (all seven tables, the partial unique index on `case_alert.alert_id` alone enforcing "one case per
  alert" at the database level, the same RLS enable/force + policy pattern as every migration since
  Prompt 1). `ReportEntity` is deliberately minimal (`id`/`tenantId`/`caseId`/`customerId`/
  `reportType`/`status`/`generatedAt`/`generatedBy`/timestamps) — **Backend Prompt 7 will need to
  extend it substantially** (narrative, flagged amount, submission fields, XML content) to build the
  real Reports module; this prompt only seeds the row `case.approve` auto-creates.
- **`apps/api/src/cases`**: `CasesService` (creation via all three entry points, the real five-state
  lifecycle's four transitions plus reassignment, the escalation checklist — one method,
  `computeChecklist()`, used by both the read endpoint and the submit-for-approval guard per Section
  3.6 — and derived-transaction lookup), `CaseNotesService`, `CaseEvidenceService` (FileStorage-backed,
  same `LocalFileStorage` construction pattern as `CustomersService`/`CustomerIngestionService`),
  `CaseTimelineService` (the denormalized nine-event-type timeline, resolved into `CasesService` via
  `forwardRef()` since the two genuinely need each other), `AlertStatusListener` (the third
  auto-transition trigger, subscribing to `alert.status_changed`/`alert.closed`), and 13 endpoints
  matching Section 4 exactly.
- **`apps/api/src/rules/alerts/alerts.service.ts`**: `assign()` now emits `ALERT_EVENTS.STATUS_CHANGED`
  when an alert's status actually changes; `close()`'s existing `ALERT_EVENTS.CLOSED` emission gained a
  `previousStatus` field. Purely additive — no existing `ALERT_EVENTS.*` subscriber existed anywhere
  before this prompt (confirmed by direct grep before making the change), so nothing that already
  depended on these events' shape could have broken.
- **Tests**: `apps/api/test/cases.e2e-spec.ts` — [fill in the actual count after Step 2] tests
  covering creation (all 3 entry points), the full state machine (every valid/invalid transition,
  maker-checker both directions), all three auto-transition triggers independently, the escalation
  checklist (all 4 items, the any-vs-every distinction), alert linking (including the checklist-3
  regression case), evidence upload/download (byte-for-byte round trip, type/size validation, dual
  audit+timeline entries), reassignment, Report auto-creation, the full assembled timeline (event
  ordering, all 9 types, the creation-time-vs-later-link distinction), tenant isolation, role gates,
  and RLS enforced directly at the database level (Step 1 above).

### Deviations from the Backend Prompt 6 spec (and why)

1. **`AlertCriticalFiredEvent` (added in Prompt 5) has no subscriber.** Its docblock, written during
   Prompt 5, anticipated "Prompt 6's Case Management subscribes to auto-open a Case" — but this
   prompt's actual written spec never asks for auto-case-creation from a critical alert, and the
   frontend mock it's built from is explicit (`docs/cases-module-frontend-inventory.md` §3): "Nothing
   else in the app auto-opens a case... every case in the live (non-seeded) data path is created by an
   explicit user action." Per the spec's own rule ("where this prompt's design differs from the mock,
   the difference is called out explicitly in §2 — everything else should be read as match the mock's
   behavior"), silence here means match the mock. The stale docblock was corrected in place rather
   than left misleading.
2. **Role-gate rejections return `403 FORBIDDEN_ROLE`, not literally `FORBIDDEN`.** This is the
   existing, already-established error code the shared `RolesGuard` has produced for every role-gated
   endpoint since Prompt 1 — introducing a second, bespoke `FORBIDDEN` code for this module alone would
   fragment the convention, not follow the spec more closely.
3. **Reassignment (`PATCH /cases/:id/assign`) rejects an already-terminal case with `400
   CASE_ALREADY_TERMINAL`**, reusing Section 3.5's own code for the same concept, even though Section
   4.8's endpoint-level error list doesn't separately enumerate it. Section 3.2's own wording — "can
   happen at any non-terminal status" — reads as an explicit guard, not merely descriptive.
4. **`case_number` generation and alert-linking's "already linked" check both have a narrow,
   accepted concurrent-race window.** `nextCaseNumber()` recomputes `(max existing sequence) + 1` per
   call rather than using a stored counter (per the spec's own explicit instruction not to introduce a
   counter table); two truly simultaneous case creations for the same tenant+year could in principle
   collide and have the second insert rejected by the `(tenant_id, case_number)` unique index. Alert
   linking's `case_alert` existence pre-check has the same class of narrow window before its own
   unique-on-`alert_id` index would catch a genuine double-link. Neither is additionally guarded with
   an advisory lock — the spec doesn't ask for one, and the mock's own `nextCaseNumber` has the
   identical non-atomic property.
5. **Evidence upload (`POST /cases/:id/evidence`) sets no Multer `limits.fileSize`.** Unlike
   `CustomersController`'s photo upload (which relies on Multer's own size limit and accepts whatever
   generic error results from exceeding it), Section 3.4 requires the exact code `400 FILE_TOO_LARGE`
   — checked explicitly in `CaseEvidenceService.upload()` against the buffered `file.size`, after
   Multer has already accepted the full upload into memory.
6. **Timeline event `text` embeds raw user ids** (e.g. "Reassigned this case to `<uuid>`") rather than
   a resolved display name, unlike the mock's `buildTimeline` (which resolves names from a
   separately-fetched `users` array). No DTO anywhere else in this backend resolves a user id to a
   display name either (`AuditLog`, `CaseNoteDto.userId`, `AlertDto.assignedTo`, etc. all store raw
   ids) — the consuming frontend is expected to resolve ids itself, exactly as it already does
   elsewhere.

### Known issues / incomplete items (Backend Prompt 6)

- **No service-level unit tests for `CasesService`/`CaseNotesService`/`CaseEvidenceService`/
  `CaseTimelineService`.** Same standing gap as every prior prompt (Prompt 1's Known Issues first
  flagged this) — all coverage is e2e-only, against a real Postgres.
- **Swagger coverage is `@ApiTags`/`@ApiBearerAuth` only**, no per-DTO `@ApiProperty()` richness in
  the generated schema — the CLI plugin that would make decorators unnecessary was never enabled
  (flagged repeatedly since Prompt 1; not something this prompt was asked to fix).
- **The `case_number`/alert-linking race windows described in Deviations #4 are real, if narrow** —
  disclosed rather than silently accepted.
- **`GET /cases/:id/checklist` and `GET /cases/:id`'s embedded `checklist` field call the exact same
  `computeChecklist()` — verified by code review (one method, two call sites), not by a dedicated test
  asserting the two responses are byte-identical for the same case.**

### Definition of Done — Backend Prompt 6 — verified vs. not verified

Fill in each row's status honestly based on the actual command output from Step 2 above (and any
manual verification actually performed) — do not mark anything ✅ without having run it against the
real `docker-compose` Postgres, per this project's standing rule since Prompt 1.

| # | Item | Status |
|---|---|---|
| 1 | Migration applies cleanly (7 tables, RLS enable/force + policies, partial unique index on `case_alert.alert_id`) | |
| 2 | Case creation: all 3 entry points, field resolution/validation order, auto-set fields, role gate | |
| 3 | Real five-state lifecycle: every valid transition succeeds, every invalid transition rejected with the correct code | |
| 4 | Auto-transition to `UNDER_INVESTIGATION`: all 3 triggers (note, evidence, linked-alert status change) independently verified, no re-fire/duplicate | |
| 5 | Genuine two-person maker-checker: submitter-cannot-be-assignee, approver-cannot-be-submitter (both directions), checklist gate, rationale/reason requirements | |
| 6 | Escalation checklist: all 4 items independently true/false, any-vs-every distinction (items 1 vs 3) | |
| 7 | Alert linking: success, customer-mismatch, already-linked, terminal-case rejection, checklist-3 regression | |
| 8 | Evidence: FileStorage upload/download byte-for-byte round trip, type/size validation, dual audit+timeline entries | |
| 9 | Report auto-creation on approval: exactly one row, correct `caseId`/`customerId`, second approval impossible (case already terminal) | |
| 10 | Timeline: all 9 event types, correct chronological ordering, creation-time-vs-later-link distinction, index-0 assignment skip | |
| 11 | Tenant isolation: every endpoint 404s (not 403s) for a cross-tenant case/note/evidence/alert-link | |
| 12 | Role gates: every action tested against every role, allowed and rejected | |
| 13 | RLS enforced at the database level (not just application-level tenant filtering) | |
| 14 | `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e` all pass across every workspace package | |

**Bottom line**: [fill in after running Step 2 — summarize what's genuinely proven against a real
Postgres vs. any gaps disclosed above, matching the tone and honesty level of every prior prompt's
bottom-line paragraph].
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/cases.e2e-spec.ts HANDOFF.md
git commit -m "test(cases): add DB-level RLS verification; document Backend Prompt 6 in HANDOFF.md"
```

---

## Plan self-review notes

- **Spec coverage**: every endpoint in §4 (4.1-4.13) has a task; every design decision in §2 (2.1-2.6) is implemented and cross-referenced from the task that builds it; every schema table in §6 has an entity + migration block in Task 2; the Report seed's HANDOFF documentation requirement (§2.4) is satisfied by Task 12 Step 3.
- **Type consistency**: `CaseDetailDto`'s five deferred fields (`notes`/`evidence`/`transactions`/`timeline`/`checklist`) are introduced empty in Task 3 and each replaced by exactly one later task (4/5/6/6/11 respectively) — verified the field names match `CaseDto`/`CaseDetailDto` (Task 1) exactly at every call site across Tasks 3-11.
- **No placeholders**: the only intentionally-incomplete artifact at any intermediate task boundary is `toDetail()`'s stubbed fields (Task 3), which is explicitly called out as correct-for-that-task rather than a TODO, and is fully resolved by Task 11.
