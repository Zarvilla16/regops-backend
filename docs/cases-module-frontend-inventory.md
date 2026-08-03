# Cases Module — Frontend Mock Inventory

Accurate, as-built inventory of what the Cases module currently does in the frontend mock layer, for use as the working reference when writing the real backend spec (Prompt 6). Not a critique, not a proposal — a description of current behavior only.

**Sources read:**
- `apps/web/src/app/(app)/cases/[id]/page.tsx` — case detail page
- `apps/web/src/app/(app)/cases/page.tsx` — case list page
- `apps/web/src/app/(app)/cases/lib.ts` — shared UI helpers/tints
- `apps/web/src/app/(app)/cases/open-case-dialog.tsx` — "Open case" modal (list page only)
- `apps/web/src/lib/mock-data/cases.ts` — types, generators, `terminalStatus`/`nextCaseNumber`
- `apps/web/src/lib/mock-data/routes.ts` — mock route handlers (`handleCase*`, `withCaseSummary`, `withCaseDetail`, `isEscalationChecklistComplete`), lines ~2000–2500 and route table ~3330–3335
- `apps/web/src/lib/mock-data/generators.ts` — `MockAuditLog` shape
- `apps/web/src/app/(app)/customers/[id]/page.tsx`, `apps/web/src/app/(app)/alerts/[id]/page.tsx` — the other two case-creation entry points

---

## 1. Data model

### `MockCase` (cases.ts:26-63)

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` (uuid) | Primary key |
| `tenantId` | `string` | Owning tenant |
| `caseNumber` | `string` | Human-readable, format `CASE-<year>-####`, sequential per year (see §3) |
| `customerId` | `string` | The one customer this case is about (case is always single-customer) |
| `alertIds` | `string[]` | 0+ alert ids, always belonging to `customerId`. Seeded cases can start with 1–3; live-created cases start with 0 or 1 (see §3) |
| `status` | `CaseStatus` | See §2 |
| `priority` | `CasePriority` | `LOW \| MEDIUM \| HIGH` |
| `assignedTo` | `string \| null` | Current assignee (user id). Null = unassigned |
| `createdBy` | `string` | User id who opened the case |
| `createdAt` | `string` (ISO) | Creation timestamp |
| `closedAt` | `string \| null` | Set only on terminal transition (`CLOSED` or `SAR_FILED`); null otherwise |
| `closedBy` | `string \| null` | User id who performed the terminal transition; null until then |
| `closureReason` | `string \| null` | Free-text reason, **only ever set when status is `CLOSED`**. Never set for `SAR_FILED` (status alone is considered self-explanatory) |
| `escalationRationale` | `string \| null` | Mandatory rationale text, set the moment the case first reaches `PENDING_APPROVAL` (at generation) or `SAR_FILED` (via a real transition). Null before that gate is passed |
| `assignmentHistory` | `CaseAssignmentEvent[]` | Full history, oldest first. Index 0 is **always** the self-assignment at creation. Further entries appended on each reassignment (see §4) |

### `CaseAssignmentEvent` (cases.ts:65-69)
| Field | Type | Meaning |
|---|---|---|
| `assignedTo` | `string \| null` | Who the case was assigned to at this point (null = unassigned) |
| `assignedBy` | `string` | Who performed the (re)assignment |
| `at` | `string` (ISO) | When |

### `MockCaseNote` (cases.ts:71-77)
| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | |
| `caseId` | `string` | |
| `userId` | `string` | Author |
| `content` | `string` | Free text |
| `createdAt` | `string` (ISO) | |

### `MockCaseEvidence` (cases.ts:79-86)
| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | |
| `caseId` | `string` | |
| `evidenceType` | `CaseEvidenceType` = `"TRANSACTION" \| "DOCUMENT" \| "SCREENING" \| "EXTERNAL"` | |
| `evidenceData` | `Record<string, unknown>` | Shape depends on `evidenceType` (see below) — **no single universal "name" field** |
| `uploadedBy` | `string` | |
| `createdAt` | `string` (ISO) | |

`evidenceData` shape by type (cases.ts `generateEvidenceData`, and `handleCaseAddEvidence` for the live-upload path):
- `TRANSACTION`: `{ transactionId, amount, date, description }`
- `DOCUMENT`: `{ documentType, fileName, uploadedAt }` — this is the **only** type reachable through the live upload UI; it always uses `documentType: "Uploaded Document"`
- `SCREENING`: `{ listChecked, matchScore, result }`
- `EXTERNAL`: `{ source, summary }`

(`TRANSACTION`, `SCREENING`, `EXTERNAL` evidence only exist in seeded demo data — there is no UI path that creates them live.)

### Derived/joined types (not persisted — assembled per-request)

`withCaseSummary` (routes.ts:2000-2020), used by the list endpoint, adds:
```
customer: { id, fullName, photoUrl, riskLevel, riskScore, kycTier, lastScreenedAt, lastRiskCalculatedAt, isPep, isSanctioned } | null
```

`withCaseDetail` (routes.ts:2030-2054), used by the detail endpoint, adds on top of the above:
- `alerts: { id, title, severity, status, scenario }[]` — lightweight summaries of the linked alerts
- `notes: MockCaseNote[]`
- `evidence: MockCaseEvidence[]`
- `transactions: MockTransaction[]` — **derived transitively**: case → `alertIds` → each alert's `transactionIds` → dedup and sort by `occurredAt`. There is no direct case→transaction link stored anywhere; a case that has zero linked alerts always has zero transactions here regardless of what evidence records exist.

Frontend-only composite type `CaseDetail` (cases/[id]/page.tsx:37-43) = `MockCase & { customer, alerts, notes, evidence, transactions }`, matching the above exactly.

---

## 2. Status lifecycle

`CaseStatus = "OPEN" | "UNDER_INVESTIGATION" | "PENDING_APPROVAL" | "CLOSED" | "SAR_FILED"` (cases.ts:13)

`terminalStatus(status)` (cases.ts:22-24): true iff `status` is `CLOSED` or `SAR_FILED`.

**The state machine is flat, not linear.** There is no UI or server code that moves a case between `OPEN` → `UNDER_INVESTIGATION` → `PENDING_APPROVAL`. Those three are just non-terminal statuses a case can be *generated* into; nothing in the live app transitions a case through them. The only two real transitions available in this build are:

| Transition | Trigger | Who | Guard(s) |
|---|---|---|---|
| any non-terminal status → `CLOSED` | "Close as false positive" button → `PATCH /cases/:id { status: "CLOSED" }` | `COMPLIANCE_OFFICER` only | Case must not already be terminal (409 `CASE_ALREADY_CLOSED` if so) |
| any non-terminal status → `SAR_FILED` | "Escalate to SAR" button → `PATCH /cases/:id { status: "SAR_FILED", escalationRationale }` | `COMPLIANCE_OFFICER` only | Case not already terminal; caller must **not** be the case's own `assignedTo` (separation-of-duties); escalation checklist (§5) must be fully complete; `escalationRationale` must be a non-empty trimmed string |

Both transitions are legal directly from `OPEN`, `UNDER_INVESTIGATION`, or `PENDING_APPROVAL` — there is no intermediate manual-approval step and no requirement to have passed through the other statuses first. `handleCaseUpdate` (routes.ts:2257-2401) is the sole enforcement point; the detail page's disabled-button reasons mirror it exactly but are not the real boundary.

**Reassignment is a separate PATCH field**, not a status transition:
- `PATCH /cases/:id { assignedTo }` — `COMPLIANCE_OFFICER` or `TENANT_ADMIN` only. `assignedTo: null` unassigns.
- **No frontend control currently calls this.** The route handler exists and is gated ("latent hardening" per its own comment) but nothing in `cases/[id]/page.tsx` or elsewhere renders a reassign UI. Every entry in `assignmentHistory` beyond index 0 in seeded data is backfilled by the generator, not produced by any live UI action.

On successful close/escalate: `status`, `closedAt`, `closedBy` are set; `closureReason` (CLOSED, defaults to a fixed string if omitted) or `escalationRationale` (SAR_FILED) is set. No other fields (e.g. `assignedTo`) change automatically.

Client-side UI enforces the exact same rules a step earlier (`escalateDisabledReason`/`closeDisabledReason` in cases/[id]/page.tsx:431-447) purely to disable/explain the buttons — it is not a second, different rule set.

---

## 3. Creation

**Endpoint:** `POST /cases` → `handleCaseCreate` (routes.ts:2163-2237)

**Role gate:** `COMPLIANCE_OFFICER` or `INVESTIGATOR` only (403 `FORBIDDEN` otherwise), enforced both server-side and client-side (buttons hidden for other roles).

**Three entry points, all hitting the same endpoint:**
1. **Cases list page** → "Open case" button → `OpenCaseDialog` (open-case-dialog.tsx). User manually picks a customer (from a full customer list fetched via looped `/customers` pages) and a priority (`LOW`/`MEDIUM`/`HIGH`, default `MEDIUM`). Sends `{ customerId, priority }`. No alert pre-fill.
2. **Customer detail page** → "Open case" button → sends `{ customerId: params.id }` only. No dialog.
3. **Alert detail page** → "Open case" button → sends `{ alertId: params.id }` only. No dialog.

Both (2) and (3) are gated client-side to the same `COMPLIANCE_OFFICER`/`INVESTIGATOR` roles (`INVESTIGATION_ACTION_ROLES` on the customer page, `CAN_MANAGE_ALERT_ROLES` on the alert page).

**Server-side field resolution (handleCaseCreate):**
- If `alertId` is given: the alert must exist in-tenant (404 `ALERT_NOT_FOUND` otherwise). Its `customerId` **always wins** over any `customerId` also passed in the body. `alertIds` becomes `[alertId]`. If no explicit `priority` was sent, priority is derived from the alert's severity: `CRITICAL`/`HIGH` severity → `HIGH` priority, else `MEDIUM`.
- If no `alertId`: `customerId` from the body is used directly, `alertIds` starts as `[]`.
- If neither resolves to a customer: 400 `CUSTOMER_REQUIRED`.
- Customer must exist in-tenant (404 `CUSTOMER_NOT_FOUND` otherwise).

**Required fields at creation (effectively):** a customer, resolved either directly or via an alert. Priority is optional (defaults `MEDIUM`, or derived from alert severity).

**Fields set automatically, not user-supplied:**
- `id` (uuid), `tenantId` (current tenant)
- `caseNumber` — via `nextCaseNumber` (cases.ts:235-245): recomputed each call as `CASE-<currentYear>-####`, sequence = max existing sequence for that year + 1 (not stored counter state)
- `status` — always starts `OPEN`
- `assignedTo` **and** `createdBy` — both set to the creating user (self-assigned at creation, no way to open a case and assign it to someone else in one step)
- `assignmentHistory` — seeded with one entry: `{ assignedTo: creator, assignedBy: creator, at: now }`
- `closedAt`, `closedBy`, `closureReason`, `escalationRationale` — all null

**Nothing else in the app auto-opens a case.** There is no automatic case creation triggered by a screening hit, a rule evaluation, an alert threshold, or any other event — every case in the live (non-seeded) data path is created by an explicit user action through one of the three entry points above. (Seeded/generated demo cases are a separate code path — `generateMockCases`, cases.ts:147-228 — driven by weighted random generation at dataset-build time, not by any simulated business event.)

---

## 4. Role-gated actions

All mutations use the mock-server pattern of a client-side gate (button visibility/disabled state) that mirrors an independent server-side gate in `routes.ts`. Both are listed since the task asked for "exact... both client-side and server-side."

| Action | Endpoint | Server-side role gate | Client-side gate | Extra guards |
|---|---|---|---|---|
| Create case | `POST /cases` | `COMPLIANCE_OFFICER` \| `INVESTIGATOR` (routes.ts:2169) | `CAN_OPEN_CASE_ROLES` (cases/page.tsx:43), `INVESTIGATION_ACTION_ROLES` (customers/[id]), `CAN_MANAGE_ALERT_ROLES` (alerts/[id]) — all identical role pairs, three separate consts | none beyond role |
| Add note | `POST /cases/:id/notes` | `COMPLIANCE_OFFICER` \| `INVESTIGATOR` (routes.ts:2412) | `CAN_ADD_NOTE_ROLES` (cases/[id]/page.tsx:323) | content must be non-empty after trim (400 `CONTENT_REQUIRED`) |
| Upload evidence | `POST /cases/:id/evidence` | `COMPLIANCE_OFFICER` \| `INVESTIGATOR` (routes.ts:2463) — explicitly "same gate as handleCaseAddNote" | `canUploadEvidence = canAddNote` (cases/[id]/page.tsx:413, reuses the note gate directly) | `fileName` must be non-empty after trim (400 `FILE_REQUIRED`) |
| Close as false positive | `PATCH /cases/:id { status: "CLOSED" }` | `COMPLIANCE_OFFICER` only (routes.ts:2284) | `closeDisabledReason` requires `COMPLIANCE_OFFICER` (cases/[id]/page.tsx:445) | case must not already be terminal |
| Escalate to SAR | `PATCH /cases/:id { status: "SAR_FILED", escalationRationale }` | `COMPLIANCE_OFFICER` only, **and** caller ≠ `mockCase.assignedTo` (routes.ts:2296, 2305) | `escalateDisabledReason` checks role, then `isInvestigator` (current user === `assignedTo`), then checklist (cases/[id]/page.tsx:432-440) | case not terminal; escalation checklist fully complete (§5); non-empty rationale |
| Reassign | `PATCH /cases/:id { assignedTo }` | `COMPLIANCE_OFFICER` \| `TENANT_ADMIN` only (routes.ts:2367) | **none — no UI control exists for this** | none beyond role |

**Separation-of-duties detail:** the SAR escalation guard checks `currentUser.id === mockCase.assignedTo` — i.e. the escalating Compliance Officer can never be the case's *currently assigned* investigator, regardless of who created the case or who was assigned at any earlier point in `assignmentHistory`. This is enforced only at the moment of escalation (routes.ts:2305-2313), with an identical client-side check (`isInvestigator`, cases/[id]/page.tsx:409) driving both the disabled-button reason and a standalone warning banner rendered whenever the current user is the assignee (lines 662-667).

Enforcement order for SAR escalation, server-side, matches the client-side reason precedence exactly: **role → separation-of-duties → checklist completeness → rationale non-empty.**

**View access:** `GET /cases` and `GET /cases/:id` have no role gate visible in the handlers — filtering is by tenant only (`handleCasesList`/`handleCaseDetail` both filter on `tenantId`). Any authenticated tenant user can view the list and any case detail; the role gates are only on mutations. (VIEWER-role visibility of the "Open case" / "Add note" / "Upload evidence" controls is handled by hiding them client-side; nothing hides the read views.)

---

## 5. The escalation checklist

Rendered in `cases/[id]/page.tsx:415-425` (client) and re-derived independently server-side in `isEscalationChecklistComplete` (routes.ts:2072-2083) from the same `withCaseDetail` join — the two are documented as intentionally sharing that join "so the two can't drift apart," though they are still two separately-written implementations, not one shared function. **This is a genuine server-side gate, not decorative**: `handleCaseUpdate` calls `isEscalationChecklistComplete(mockCase)` and returns 400 `ESCALATION_CHECKLIST_INCOMPLETE` if it fails, independent of and in addition to whatever the client renders.

The four items:

| # | Label | Checked against | Logic |
|---|---|---|---|
| 1 | "At least one linked alert reviewed" | `case.alerts[].status` | `true` if **any** linked alert has `status !== "NEW"` (i.e. at least one has moved past `NEW`, regardless of the others) |
| 2 | "At least one investigation note added" | `case.notes` | `true` if `notes.length > 0` |
| 3 | "Linked transactions reviewed" | `case.transactions`, `case.alerts[].status` | `true` if the case has **zero** linked transactions (nothing to review), **or** if `every` linked alert has `status !== "NEW"` — note this is a stricter condition than item 1 (all, not any) |
| 4 | "Customer risk score is current" | `customer.lastRiskCalculatedAt`, `customer.riskLevel` | `false` if `lastRiskCalculatedAt` is null; otherwise `true` if `now - lastRiskCalculatedAt <= cadence`, where cadence by risk band is `CRITICAL: 1 day, HIGH: 1 day, MEDIUM: 7 days, LOW: 30 days` (documented as pulled from "the v1 spec §4.2") |

`checklistComplete = checklist.every(item => item.checked)` — all four must pass. The cadence table (`RESCORE_CADENCE_DAYS`) is duplicated verbatim in both the page component and routes.ts (routes.ts comment explicitly notes it can't be imported because the page module is `"use client"`), so it is two copies of the same constant, not one shared source.

---

## 6. Timeline / audit

These are two **separate, non-overlapping** systems: the visible case timeline is built client-side by reading denormalized fields off the case detail response; the audit log is a separate `MockAuditLog[]` collection written by route handlers. The timeline never reads the audit log, and the audit log is not surfaced anywhere on the case detail page.

### Visible timeline (`buildTimeline`, cases/[id]/page.tsx:243-320)

A single chronologically-sorted (`sort by .at`) feed assembled from:
1. **Opened event** — always present, `at: createdAt`, author = `createdBy`. Text varies by how many alerts were linked at creation: "Opened this case." (0 alerts) / names the one alert (1 alert) / lists all titles (2–3 alerts, seeded only).
2. **Reassignment events** — one per `assignmentHistory` entry **from index 1 onward only** (index 0, the creation self-assignment, is skipped since it's already implied by the opened event). Text: "Reassigned this case to X." or "Unassigned this case." if `assignedTo` is null.
3. **Note events** — one per `case.notes` entry, author = note's `userId`, text = raw note content.
4. **Transaction events** — one per `case.transactions` entry (the derived alert→transaction join, §1), author always the literal string `"System"`, text is a formatted summary: `"{type} transaction — {narration}, ₦{amount} via {channel}."`.
5. **Terminal event** — only if `closedAt` is set. If `status === "SAR_FILED"`: "Escalated and approved this case for SAR filing." If `CLOSED`: "Closed this case as a false positive. {closureReason}". Author = `closedBy`. This is documented as **one combined event** representing escalation-and-approval as a single actor/action, not two separate workflow steps — there is no separate "approved" event distinct from "escalated."

No other event types exist in the timeline (no evidence-upload events, despite evidence having its own timestamped list rendered in a separate "Evidence" card on the same page).

### Audit log (`MockAuditLog`, generators.ts:601-613)

Fields: `id, tenantId, userId, action, entityType, entityId, beforeState, afterState, ipAddress, userAgent, createdAt`.

Case-related actions actually written (all via `dataset.auditLogs.unshift(...)` in routes.ts):

| Handler | `action` | `entityType`/`entityId` | `beforeState` | `afterState` |
|---|---|---|---|---|
| `handleCaseCreate` | `"case.opened"` | `case` / new case id | `null` | `{ caseNumber, status, customerId, alertIds }` |
| `handleCaseUpdate` (status branch) | `"case.escalated"` or `"case.closed"` | `case` / case id | `{ status: beforeStatus }` | `{ status, closureReason, escalationRationale }` |
| `handleCaseUpdate` (assignedTo branch) | `"case.reassigned"` | `case` / case id | `{ assignedTo: beforeAssignedTo }` | `{ assignedTo }` |
| `handleCaseAddNote` | `"case.note_added"` | `case` / case id | `null` | `{ noteId }` |
| `handleCaseAddEvidence` | `"case.evidence_uploaded"` | `case` / case id | `null` | `{ evidenceId, fileName }` |

Every one of these sets `ipAddress`/`userAgent` via `mockRequestIpAddress()` / the fixed `MOCK_REQUEST_USER_AGENT` string (per the recent fix noted in the repo's commit history — "audit log missing IP/user-agent on live writes"). Note that evidence upload **is** audit-logged (`case.evidence_uploaded`) even though it has no corresponding timeline entry on the detail page — the two systems diverge here.

---

## 7. Relationships

- **Case → Customer**: one-to-one, `customerId` (required, immutable after creation — no endpoint changes it). Detail view shows the full `CustomerSummaryCard` (fields: `id, fullName, photoUrl, riskLevel, riskScore, kycTier, lastScreenedAt, lastRiskCalculatedAt, isPep, isSanctioned` — see `withCaseSummary`). List view shows only `customer.fullName` as a link to `/customers/:id`.
- **Case → Alerts**: one-to-many via `alertIds: string[]`, always same-customer alerts. Populated at creation only (1 if via `alertId`, 0 if via bare `customerId`, 1–3 for seeded data) — **there is no endpoint to link/unlink an alert to an existing case after creation.** Detail view shows each linked alert as a summary card (`id, title, severity, status, scenario`) linking out to `/alerts/:id`. List view shows only the count (`alertIds.length`).
- **Case → Transactions**: no stored link. Fully derived per-request: case's `alertIds` → each alert's own `transactionIds` → fetch, dedupe, sort by `occurredAt`. Shown in full (`MockTransaction` objects) only in the detail response/timeline; not shown at all on the list page.
- **Case → Reports (SAR)**: not modeled as a stored relationship in the Cases data at all. Escalating a case to `SAR_FILED` does not create or link a Report record from within `handleCaseUpdate` — reports.ts's SAR generation (`buildSarXml`, referenced in a cases.ts comment) is a separate concern not touched by this handler.
- **Case → Evidence / Notes**: one-to-many, stored as separate collections (`caseEvidence`, `caseNotes`) filtered by `caseId`, joined in on every detail fetch.

---

## 8. Other details

**Evidence upload — file handling:** No real file storage exists in this mock. The file `<input type="file">` (cases/[id]/page.tsx:548-556) has no `accept` attribute (no file-type restriction in the UI) and no client-side size check. On selection, only `file.name` is sent to the server (`POST /cases/:id/evidence { fileName }`) — file contents are never uploaded or read. The server always records this as `evidenceType: "DOCUMENT"` with `evidenceData: { documentType: "Uploaded Document", fileName, uploadedAt }`, regardless of the actual file's extension/type. This is the same "no real storage" pattern used elsewhere in the mock (e.g. customer photo upload).

**Escalation rationale requirement:** Required only for the `SAR_FILED` transition, never for `CLOSED`. Enforced twice: client-side, the confirm dialog's confirm button is disabled while the textarea is empty/whitespace-only (`confirmDisabled`, cases/[id]/page.tsx:701); server-side, `handleCaseUpdate` independently trims and rejects an empty value with 400 `ESCALATION_RATIONALE_REQUIRED` (routes.ts:2323-2329). There is no minimum length beyond non-empty, and no rationale field/prompt exists for `CLOSED` (which instead has an optional `closureReason` that defaults to a fixed string if omitted).

**Pagination/filtering (list endpoint):** `GET /cases` supports `status` (comma-separated), `priority` (comma-separated), `assigned_to` (a user id, or the literal string `"unassigned"`), `q` (free-text match against `caseNumber` or customer `fullName`, case-insensitive substring), `page`, `limit` (default 25, max 100). Note: `assigned_to` filtering exists server-side but the Cases list page UI does not currently expose an "assigned to" filter control — only Status and Priority filter chips are rendered.

**Stats on the list page:** No `/cases/stats` endpoint exists. The page fetches up to 100 cases unfiltered and derives `Total / Open / Under investigation / SAR filed` counts client-side (cases/page.tsx:120-133).

**Tenant isolation:** Every case handler filters by `tenantId === currentTenant.id` (list, detail, create's customer/alert lookups, update). A case belonging to another tenant is treated identically to a nonexistent one (404), not a 403.
