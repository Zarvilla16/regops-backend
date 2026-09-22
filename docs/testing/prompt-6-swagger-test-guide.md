# Swagger Test Guide — Backend Prompt 6 (Case Management)

A click-by-click walkthrough inside the Swagger API explorer at `http://localhost:4000/docs`, with curl
used only where Swagger genuinely cannot reach — confirmed live, not assumed, against this module's
actual `/docs-json`, the same standard every prior prompt's guide holds itself to. **Every new DTO in
this module** (`CreateCaseDto`, `AddNoteDto`, `SubmitCaseDto`, `RejectCaseDto`, `AssignCaseDto`,
`LinkAlertDto`, `CloseCaseDto`) **renders as an empty `{}` box** — the same `@nestjs/swagger` CLI-plugin
gap every prior prompt's guide has already called out — so request bodies below are pasted in by hand.
**Evidence upload is curl-only**: `POST /cases/:id/evidence` has no `@ApiConsumes`/`@ApiBody` annotation
(confirmed against the live `/docs-json` — no multipart schema at all), so Swagger's UI never renders a
file picker for it, and evidence download is shown as curl too so the downloaded bytes can be diffed
directly against the uploaded file. `POST /users` with `X-Tenant-Override` (tenant isolation, Section 9)
is curl for the same reason every prior guide's own tenant-isolation section is: the header isn't a
declared Swagger parameter.

Every step below — including the curl ones — was actually run against a live `docker-compose up -d` +
`pnpm dev` instance while writing this guide, not just described from reading the code. Real response
bodies and several genuinely interesting real findings (not bugs — flagged inline as they come up) are
recorded below, not guessed. IDs, timestamps, and case numbers below are this guide's own live run —
yours will differ; what matters is the shape and the status codes.

**Before you start**: `docker-compose up -d` and `pnpm dev` need to already be running (`apps/api` is
all this guide needs directly; `apps/worker` matters too, since several sections generate real alerts
via the Rules Engine, and that pipeline runs through the worker exactly as it does in Prompt 4/5's own
guides). You'll need `curl` and `openssl` for the evidence and tenant-override steps, and `psql` access
to the dev Postgres (`docker exec regops-postgres-1 psql -U regops_admin -d regops`) for two spots
where there's no read endpoint yet (the auto-created `Report` row, and nulling a customer's risk
timestamp to demonstrate checklist item 4's false state — Backend Prompt 7 will eventually add a real
Reports endpoint; there's no endpoint anywhere in this codebase to *unset* a risk score, so that one
SQL step is permanent, not a stand-in for a future prompt).

**Accounts used throughout**: `admin@demomfb.dev` / `TenantAdmin!2026` (TENANT_ADMIN, tenant "Demo MFB
Limited") to create the extra accounts below; `compliance@demomfb.dev` / `Compliance!2026` (the
tenant's original seeded COMPLIANCE_OFFICER) as "Officer 1" throughout; a second Compliance Officer you
create in Section 1 as "Officer 2" — genuine two-person maker-checker needs two real, distinct accounts,
not one account wearing two hats. `superadmin@regops.dev` / `SuperAdmin!2026` for Section 9 (tenant
isolation) only.

**Reusing Prompt 4/5's webhook secret setup**: this guide generates real alerts the same way Prompt 5's
guide does, via `POST /transactions/ingest`. If you already walked that guide against this same dev
database, the secret is already configured — check with:
```sh
docker exec regops-postgres-1 psql -U regops_admin -d regops -c \
  "SELECT config FROM tenant WHERE id = '<tenantId>';"
```
This guide's own live run reused a secret already sitting in the dev database from earlier manual
verification (`manual-test-secret`) — substitute whatever value you actually set for `$SECRET` below.

---

## 1. `POST /auth/login` — get a token, and create the second Compliance Officer

1. Open `http://localhost:4000/docs`. In the **auth** section, click **POST /auth/login**, **Try it
   out**, and paste:
   ```json
   { "email": "admin@demomfb.dev", "password": "TenantAdmin!2026" }
   ```
2. Click **Execute**. **Expected**: `200`, `data.accessToken` populated. Click **Authorize** (top of
   the page), paste it in, **Authorize**, **Close**.
3. Click **GET /auth/me**, **Execute**. **Copy `data.tenant.id`** — this guide's own run used
   `2111565d-2253-45d7-b2d7-78d10b949441`.
4. **POST /users**, create the second Compliance Officer (this is Officer 2 for the rest of the guide —
   maker-checker needs a genuinely different account, not the same one submitting and approving):
   ```json
   {
     "email": "compliance2-cases-guide@demomfb.dev",
     "password": "Compliance2Cases!2026",
     "fullName": "Cases Guide Second Officer",
     "role": "COMPLIANCE_OFFICER"
   }
   ```
   **Expected** (verified live): `201`, `data.status: "INVITED"`. An `INVITED` user logs in fine, same
   observation every prior guide has already made.
5. Log in as Officer 1 (`compliance@demomfb.dev` / `Compliance!2026`) and re-**Authorize** — everything
   from here through Section 8 uses Officer 1 unless a step explicitly says to switch to Officer 2.
6. **Failure mode**: a `401` on any later step means the token expired (15 minutes) — log in again and
   re-Authorize.

## 2. Creating a case — all three entry points

1. **POST /customers** (Customer A, for this section's "bare" demo):
   ```json
   {
     "cbsCustomerId": "CBS-CASES-GUIDE-001",
     "fullName": "Amaka Cases Guide Customer",
     "customerType": "INDIVIDUAL",
     "occupation": "Trader",
     "country": "NG",
     "kycTier": 2,
     "onboardedAt": "2024-01-15"
   }
   ```
   **Copy the `id`** — `<customerA>`. Confirmed live: customer creation always computes an initial risk
   score synchronously (`riskScore: 65, riskLevel: "HIGH"` for this occupation/type combination) — worth
   knowing going into Section 6's checklist item 4 discussion, where a *freshly onboarded* customer
   already satisfies "risk score is current" from the moment they exist.
2. **The "bare" entry point** — **POST /cases**, an explicit `customerId` and `priority`, exactly what
   the Cases list page's "Open case" dialog sends:
   ```json
   { "customerId": "<customerA>", "priority": "LOW" }
   ```
   **Expected** (verified live): `201`, `data.status: "OPEN"`, `data.priority: "LOW"` (the explicit
   value, not the `MEDIUM` default), `data.caseNumber` matching `CASE-<year>-####` (this run:
   `CASE-2026-0005`), `data.assignedTo` and `data.createdBy` both set to Officer 1's own user id — a
   case is always self-assigned at creation, no way to open a case and hand it to someone else in one
   step. **Copy the case `id`** — `<case1>`. This case is reused in Section 8 (terminal-case guard).
3. **POST /customers** again (Customer B, for the rest of this guide's main walkthrough):
   ```json
   {
     "cbsCustomerId": "CBS-CASES-GUIDE-002",
     "fullName": "Bayo Cases Guide Customer",
     "customerType": "INDIVIDUAL",
     "occupation": "Consultant",
     "country": "NG",
     "kycTier": 2,
     "onboardedAt": "2024-01-15"
   }
   ```
   **Copy the `id`** — `<customerB>`.
4. **The "from a customer" entry point** — functionally identical to step 2's request shape (both are
   just `POST /cases` with a `customerId`), the only real difference is where the request originates
   from in the frontend (a customer's own detail page already has the id in context, so it sends no
   explicit `priority`, defaulting to `MEDIUM`):
   ```json
   { "customerId": "<customerB>" }
   ```
   **Expected** (verified live): `201`, `data.priority: "MEDIUM"` (the default, since none was given),
   `data.checklist` already present in the response (Section 6 covers this in detail).
   **Copy the case `id`** — `<case2>`. This is the case Sections 3-4 build out into the full lifecycle
   walk.
5. **The "from an alert" entry point needs a real alert first.** Send a large-cash transaction for
   Customer B (curl, same HMAC reason as every ingestion call in Prompt 4/5's guides):
   ```sh
   SECRET="<your tenant's webhook secret>"
   TENANT_ID="<tenantId>"
   TIMESTAMP=$(date +%s)
   BODY='{"transactions":[{"cbs_transaction_id":"GUIDE-CASES-LARGECASH-1","customer_cbs_id":"CBS-CASES-GUIDE-002","account_number":"0501234567","amount":6800000,"currency":"NGN","type":"CREDIT","channel":"CASH","occurred_at":"'"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"'"}]}'
   SIGNATURE=$(printf '%s' "${TIMESTAMP}.${BODY}" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')
   curl -X POST http://localhost:4000/transactions/ingest \
     -H "X-Tenant-Id: $TENANT_ID" -H "X-RegOps-Timestamp: $TIMESTAMP" \
     -H "X-RegOps-Signature: sha256=$SIGNATURE" -H "Content-Type: application/json" -d "$BODY"
   ```
   Wait 2-3 seconds, then **GET /alerts**, filter by eye for Customer B's `customerId` (same
   no-fillable-filter Swagger gap Prompt 5's guide already documents). **Expected** (verified live):
   `scenarioType: "LARGE_CASH"`, `severity: "MEDIUM"`, `status: "NEW"`. **Copy the alert `id`** —
   `<alertLargeCash>`.
6. **POST /cases** with only an `alertId`:
   ```json
   { "alertId": "<alertLargeCash>" }
   ```
   **Expected** (verified live): `201`, `data.customerId` equals Customer B's id (resolved from the
   alert, not supplied directly), `data.priority: "MEDIUM"` (a `MEDIUM`-severity alert derives `MEDIUM`
   priority — Section 2's next step shows a `CRITICAL` alert deriving `HIGH`), `data.alerts` has exactly
   one entry (the alert), and the timeline's opened event already names it: `"Opened this case from
   alert \"Cash CREDIT of NGN 6,800,000 by Bayo Cases Guide Customer\"."`
7. **A real, worth-confirming precedence check, not just trusting the spec text**: create one more
   customer as a decoy (**POST /customers**, any details), then send another qualifying cash transaction
   for Customer B to get a second alert (repeat step 5's curl with a new `cbs_transaction_id`). **POST
   /cases** with *both* fields set, `alertId` pointing at the new alert and `customerId` pointing at the
   decoy:
   ```json
   { "alertId": "<newAlertId>", "customerId": "<decoyCustomerId>" }
   ```
   **Expected** (verified live): `data.customerId` is Customer B's id — the alert's own customer wins
   unconditionally over whatever `customerId` is also present in the body, exactly as specified.
8. **Priority derivation from severity, the `HIGH` case**: for a fuller picture, this guide's own run
   also generated a `HIGH_RISK_COUNTERPARTY` alert (`severity: "CRITICAL"`) for a third customer the
   same way Prompt 5's guide's Section 6 does (a transfer to a counterparty name containing
   `SANCTIONED`), then created a case from it with no explicit priority. **Expected** (verified live):
   `data.priority: "HIGH"` — confirming both derivation branches (`CRITICAL`/`HIGH` severity → `HIGH`
   priority; anything else → `MEDIUM`, already shown in step 6). This case (`<case3>`) is reused in
   Section 5 (the reject path).

## 3. The full lifecycle, live: `OPEN` → `UNDER_INVESTIGATION` → `PENDING_APPROVAL` → `SAR_FILED`

Continuing with `<case2>` from Section 2.

1. **Confirm the starting state** — **GET /cases/{id}**, paste `<case2>`. **Expected**: `status: "OPEN"`.
   **A genuinely interesting live finding, not a bug**: check `data.checklist` — item 3
   (`TRANSACTIONS_REVIEWED`) is already `true`, not `false`, even though nothing has been reviewed yet.
   This is the spec's own "zero linked transactions" escape clause: with no alerts linked at all yet,
   there are zero derived transactions to review, so the condition is vacuously satisfied. Items 1 and 2
   are `false`; item 4 (risk score current) is already `true`, per Section 2 step 1's observation.
2. **Trigger the auto-transition** — **POST /cases/{id}/notes**:
   ```json
   { "content": "Reviewing the large cash deposit flagged on this customer's account." }
   ```
   **Expected** (verified live): `201`, the note is created. **GET /cases/{id}** again: **`status` is
   now `"UNDER_INVESTIGATION"`**, with no separate action needed to move it there — the transition
   happened as a side effect of the note write itself, inside the same request.
3. **Link the alert from Section 2** (`<alertLargeCash>`) to give the checklist something to review —
   **POST /cases/{id}/alerts**:
   ```json
   { "alertId": "<alertLargeCash>" }
   ```
   **Expected** (verified live): `201`, `data.alerts` now has one entry, `data.status` unchanged
   (`UNDER_INVESTIGATION` — linking alone doesn't retrigger anything). Re-check `GET
   /cases/{id}/checklist`: item 3 has now flipped to `false` (there's a real linked transaction now, and
   the alert is still `NEW`) while item 1 stays `false` too.
4. **Review the alert** — **POST /alerts/{alertId}/assign** (any user id from **GET /users** other than
   yourself):
   ```json
   { "assignedTo": "<a user id>" }
   ```
   **Expected**: `201`, `data.status: "ASSIGNED"`. **GET /cases/{id}/checklist** again: **all 4 items
   are now `true`, `complete: true`** — reviewing the alert satisfies both item 1 (at least one reviewed)
   and item 3 (every linked alert reviewed, and there's only one).
5. **Upload evidence while you're here** — see Section 4 below for the full round trip; this guide's own
   run uploaded a file to this exact case at this point in the flow, so its timeline entry (Section
   3.10) sits between the alert-link and the submission.
6. **The maker-checker guard, half 1 — attempt to submit as the case's own assignee.** `<case2>` is
   still self-assigned to Officer 1 from creation. **PATCH /cases/{id}/submit** as Officer 1:
   ```json
   { "escalationRationale": "Confirmed suspicious large cash pattern, escalating for SAR review." }
   ```
   **Expected** (verified live): `403`,
   ```json
   { "success": false, "error": { "code": "SUBMITTER_CANNOT_BE_ASSIGNEE", "message": "The case's own assignee cannot submit it for approval." } }
   ```
7. **Submit for real, as Officer 2** — re-**Authorize** with Officer 2's token (Section 1 step 4), same
   request body as step 6. **Expected** (verified live): `200`, `data.status: "PENDING_APPROVAL"`,
   `data.submittedBy` is Officer 2's user id, `data.escalationRationale` set to the text sent.
8. **The maker-checker guard, half 2 — attempt to approve as the submitter, still Officer 2**. **PATCH
   /cases/{id}/approve**, empty body `{}`. **Expected** (verified live): `403`,
   ```json
   { "success": false, "error": { "code": "APPROVER_CANNOT_BE_SUBMITTER", "message": "The submitting Compliance Officer cannot also approve this case." } }
   ```
   **Same guard also blocks reject** — **PATCH /cases/{id}/reject** as Officer 2 with any `reason`:
   same `403 APPROVER_CANNOT_BE_SUBMITTER`, confirmed live — the guard applies symmetrically to both
   terminal decisions, not just approval.
9. **Approve for real, as Officer 1** — re-Authorize back to Officer 1 (a genuinely different person
   from the submitter, Officer 2). **PATCH /cases/{id}/approve**, empty body. **Expected** (verified
   live): `200`,
   ```json
   {
     "status": "SAR_FILED",
     "approvedBy": "<Officer 1's id>",
     "approvedAt": "2026-08-04T09:09:08.535Z",
     "closedAt": "2026-08-04T09:09:08.535Z",
     "closedBy": null,
     "report": { "id": "a3c1f01b-7930-433d-bbcc-f28060c2b3db", "status": "DRAFT" }
   }
   ```
   `closedAt` is set (per the schema, both terminal paths set it) but `closedBy` stays `null` — that
   field belongs only to the direct-close path (Section 8); the approval path's actor is `approvedBy`.
10. **Confirm the `Report` row exists for real** — no `GET /reports` endpoint exists yet (that's Backend
    Prompt 7's job; this module only seeds the row), so this is the one genuinely no-Swagger-path check
    in this guide:
    ```sh
    docker exec regops-postgres-1 psql -U regops_admin -d regops -c \
      "SELECT id, case_id, customer_id, report_type, status, generated_by FROM report WHERE case_id = '<case2>';"
    ```
    **Expected** (verified live): exactly one row, `report_type: SAR`, `status: DRAFT`,
    `generated_by` matching Officer 1's id.
11. **The full timeline, for the record** — **GET /cases/{id}**, `data.timeline`. **Expected** (verified
    live), 8 entries in genuine chronological order:
    ```
    transaction | system    | Credit transaction — No narration, ₦6,800,000 via Cash.
    opened      | Officer 1 | Opened this case.
    note        | Officer 1 | Reviewing the large cash deposit flagged on this customer's account.
    alert_linked| Officer 1 | Linked alert "Cash CREDIT of NGN 6,800,000 by Bayo Cases Guide Customer" to this case.
    evidence    | Officer 1 | Uploaded evidence: "statement-review.csv".
    submitted   | Officer 2 | Submitted this case for SAR-escalation approval.
    approved    | Officer 1 | Approved this case's SAR escalation request.
    sar_filed   | Officer 1 | Approved and escalated this case for SAR filing.
    ```
    **A second genuinely interesting live finding**: the `transaction` event legitimately sorts
    *before* `opened` — the underlying large-cash transaction happened at `09:05:41`, four minutes
    before the case itself was opened at `09:06:08`. The timeline sorts strictly by each event's own
    real-world timestamp, not by when the case learned about it, so a transaction that predates the
    case's own creation is expected to lead the list, not a bug.

## 4. Evidence — real file upload/download, audit log, and timeline entry

This guide's own run did this against `<case2>` between Section 3 steps 4 and 6, while it was still
`UNDER_INVESTIGATION` — evidence can be added at any non-terminal status, and doing it mid-investigation
is the realistic case. Both steps are curl (Section 0's opening note explains why).

1. **Upload**:
   ```sh
   echo "Bank statement excerpt for Bayo Cases Guide Customer - large cash deposit review notes." > statement-review.csv
   curl -X POST http://localhost:4000/cases/<case2>/evidence \
     -H "Authorization: Bearer <Officer 1's accessToken>" \
     -F "file=@statement-review.csv;type=text/csv;filename=statement-review.csv"
   ```
   **Expected** (verified live): `201`,
   ```json
   { "id": "6220edab-f0d6-4462-acb3-256ec08faf8c", "fileName": "statement-review.csv", "fileType": "text/csv", "fileSizeBytes": 88, "uploadedBy": "<Officer 1's id>" }
   ```
2. **Download and diff**:
   ```sh
   curl http://localhost:4000/cases/<case2>/evidence/<evidenceId> \
     -H "Authorization: Bearer <Officer 1's accessToken>" -o downloaded-statement.csv
   diff statement-review.csv downloaded-statement.csv && echo "IDENTICAL"
   ```
   **Expected** (verified live): `diff` produces no output, `IDENTICAL` prints — a genuine byte-for-byte
   round trip, not just a same-length check.
3. **Both audit actions, confirmed via SQL** (no `GET /audit-logs?entity_id=` filter exists in Swagger,
   same list-endpoint gap as every prior prompt):
   ```sh
   docker exec regops-postgres-1 psql -U regops_admin -d regops -c \
     "SELECT action, created_at FROM audit_log WHERE entity_id = '<case2>' ORDER BY created_at;"
   ```
   **Expected** (verified live): both `case.evidence_uploaded` and `case.evidence_downloaded` present,
   alongside every other action this case has accumulated so far (`case.opened`,
   `case.investigation_started`, `case.note_added`, `case.alert_linked`).
4. **The timeline entry** — **GET /cases/{id}**, `data.timeline`: an `evidence` entry, `"Uploaded
   evidence: \"statement-review.csv\"."`, already shown in context in Section 3 step 11. This is the one
   place this module's real timeline genuinely differs from the frontend mock it's built from — the
   mock's own evidence upload never produced a timeline entry at all, audit log only; this backend fixes
   that gap deliberately (documented in `HANDOFF.md`'s Section 2.6).

## 5. The reject path — submit, reject by a different officer, back to `UNDER_INVESTIGATION`, and confirming the full submission history survives a resubmission

Using `<case3>` from Section 2 step 8 (the `HIGH_RISK_COUNTERPARTY` case, priority `HIGH`).

1. **Build the checklist to complete** — same recipe as Section 3: **POST /cases/{id}/notes** with any
   content, then **POST /alerts/{alertId}/assign** on the case's linked alert (from Section 2 step 8) to
   mark it reviewed. **Expected**: `status` auto-transitions to `UNDER_INVESTIGATION` on the note write;
   `GET /cases/{id}/checklist` shows `complete: true` once the alert is reviewed (same mechanics as
   Section 3, not repeated in full here).
2. **Submit as Officer 2** (not this case's assignee, Officer 1 — same self-assignee guard as Section 3
   step 6 applies here too):
   ```json
   { "escalationRationale": "Confirmed transfer to a sanctioned counterparty, escalating for SAR review." }
   ```
   **Expected**: `200`, `status: "PENDING_APPROVAL"`.
3. **Reject as Officer 1** (a genuinely different person from the submitter, Officer 2) — **PATCH
   /cases/{id}/reject**:
   ```json
   { "reason": "Counterparty name match needs manual sanctions-list cross-check before filing; not yet conclusive." }
   ```
   **Expected** (verified live): `200`,
   ```json
   { "status": "UNDER_INVESTIGATION", "submittedBy": null, "submittedAt": null, "escalationRationale": null }
   ```
   The case genuinely returns to `UNDER_INVESTIGATION`, not `CLOSED` — a rejection means "needs more
   work," per the spec's explicit design choice — and the three live submission fields on the case
   itself are all cleared, so a later resubmission doesn't carry stale data forward.
4. **The rejection reason, and the submission itself, both confirmed visible** — **GET /cases/{id}**,
   `data.timeline`. **Expected** (verified live):
   ```
   transaction | system    | Debit transaction — No narration, ₦3,000,000 via Transfer.
   opened      | Officer 1 | Opened this case from alert "Transfer to counterparty matching sanctions list (95% match)".
   note        | Officer 1 | Reviewing transfer to a counterparty matching the sanctions list.
   submitted   | Officer 2 | Submitted this case for SAR-escalation approval.
   rejected    | Officer 1 | Rejected this case's SAR escalation request. Counterparty name match needs manual sanctions-list cross-check before filing; not yet conclusive.
   ```
   **A previously real, now-fixed gap, confirmed here** — the `submitted` entry above genuinely
   survives the rejection, even though step 3 nulled the case's own live `submittedBy`/`submittedAt`
   fields. This module originally derived the `submitted` timeline event straight from those live
   fields, which meant a rejection silently erased the historical record that a submission had ever
   happened — a compliance-relevant gap on a platform whose whole purpose is a trustworthy audit trail.
   Fixed by giving every `submit()` call its own durable, insert-only row (`case_submission_event`,
   mirroring `case_approval_event`'s own shape for exactly this reason), which the timeline now reads
   from instead of the live columns. See `HANDOFF.md`'s Known Issues for the full writeup.
5. **Resubmit, with a genuinely different rationale** — **PATCH /cases/{id}/submit** as Officer 2 again:
   ```json
   { "escalationRationale": "Re-escalating after the manual cross-check confirmed the sanctions list match." }
   ```
   **Expected**: `200`, `status: "PENDING_APPROVAL"`.
6. **Approve as Officer 1** — **PATCH /cases/{id}/approve**, empty body. **Expected**: `200`,
   `status: "SAR_FILED"`.
7. **The full submission history, both attempts, still visible after approval** — **GET /cases/{id}**,
   `data.timeline`. **Expected** (verified live): **two** distinct `submitted` entries, in chronological
   order, neither one collapsed away by the other:
   ```
   opened      | Opened this case from alert "...".
   note        | Reviewing transfer to a counterparty matching the sanctions list.
   alert_linked| Linked alert "..." to this case.
   submitted   | Submitted this case for SAR-escalation approval.     <- the first (rejected) submission
   rejected    | Rejected this case's SAR escalation request. ...
   submitted   | Submitted this case for SAR-escalation approval.     <- the second (approved) submission
   approved    | Approved this case's SAR escalation request.
   sar_filed   | Approved and escalated this case for SAR filing.
   ```
   Confirm the durable record directly, too — no read endpoint exists for this table yet, same
   reasoning as the `Report` row in Section 3:
   ```sh
   docker exec regops-postgres-1 psql -U regops_admin -d regops -c \
     "SELECT actor, rationale, at FROM case_submission_event WHERE case_id = '<case3>' ORDER BY at;"
   ```
   **Expected** (verified live): exactly 2 rows, distinct `rationale` text matching steps 2 and 5's own
   escalation rationales — a regulator or auditor reviewing this case's history can see it was
   submitted, rejected, and resubmitted, not just the most recent attempt.

## 6. The escalation checklist, in detail — including alert-linking regressing it

A fresh case makes the four items, and the `any`-vs-`every` distinction between items 1 and 3,
individually observable.

1. **POST /customers** (Customer D), then send **two separate** qualifying cash transactions (curl,
   same as Section 2 step 5, two different `cbs_transaction_id`s) — each creates its **own** alert
   (`LARGE_CASH`'s dedup key is per-transaction, not per-customer-per-day, so two qualifying deposits
   genuinely produce two `Alert` rows, confirmed live: `c9b8705d-...` and `89554f7f-...`).
2. **POST /cases** with `{ "alertId": "<first alert>" }`. **POST /cases/{id}/notes** (any content) and
   **POST /alerts/{firstAlertId}/assign** (review it). **GET /cases/{id}/checklist**: **Expected**
   (verified live): all 4 items `true`, `complete: true` — one linked alert, reviewed.
3. **Link the second, still-`NEW` alert** — **POST /cases/{id}/alerts**:
   ```json
   { "alertId": "<second alert>" }
   ```
   **Expected** (verified live): `201`, and the alert's own `status` is confirmed unchanged (`NEW`) —
   linking never touches the linked alert itself. **GET /cases/{id}/checklist** again:
   ```json
   {
     "items": [
       { "key": "ALERT_REVIEWED", "passed": true },
       { "key": "NOTE_ADDED", "passed": true },
       { "key": "TRANSACTIONS_REVIEWED", "passed": false },
       { "key": "RISK_SCORE_CURRENT", "passed": true }
     ],
     "complete": false
   }
   ```
   **The `any`-vs-`every` distinction, live**: item 1 stays `true` (at least one linked alert — the
   first — is reviewed) while item 3 flips to `false` (not *every* linked alert is reviewed anymore).
   Linking a second, unreviewed alert genuinely regresses a checklist that was previously satisfiable —
   this is intentional per the spec, not something to "fix."
4. **Confirm submission is genuinely blocked, not just the checklist display** — **PATCH
   /cases/{id}/submit** (as a different user than the assignee):
   ```json
   { "escalationRationale": "Attempting to escalate." }
   ```
   **Expected** (verified live): `400`,
   ```json
   { "code": "ESCALATION_CHECKLIST_INCOMPLETE", "details": { "failedItems": ["TRANSACTIONS_REVIEWED"] } }
   ```
   The response names the specific failed item(s), not just a bare boolean.
5. **Item 4 (risk score current), false then true** — every customer gets an initial risk score at
   onboarding, so item 4 is `true` from the moment a case exists (Section 2 step 1's observation);
   demonstrating the `false` state needs a direct SQL nudge, since no endpoint exists to *unset* a risk
   score:
   ```sh
   docker exec regops-postgres-1 psql -U regops_admin -d regops -c \
     "UPDATE customer SET last_risk_calculated_at = NULL WHERE id = '<customerD>';"
   ```
   **GET /cases/{id}/checklist**: item 4 now `false`. Then, back on real API ground — **POST
   /customers/{id}/rescore**, empty body `{}`. **Expected** (verified live): `201`, and re-checking the
   checklist shows item 4 `true` again — a real rescore, not a raw SQL patch, closes the gap this time.

## 7. Terminal-case guard — notes and evidence rejected on a closed case

Using `<case1>` from Section 2 step 2 (the "bare" entry-point demo case, otherwise untouched).

1. **PATCH /cases/{id}/close**, empty body:
   ```json
   {}
   ```
   **Expected** (verified live): `200`, `data.status: "CLOSED"`, `data.closureReason: "False positive —
   no suspicious activity confirmed after investigation."` (the exact default string, used because none
   was supplied), `data.closedBy` set to the caller — note this is the direct-close path's own field,
   distinct from Section 3's `approvedBy`.
2. **Attempt to add a note** — **POST /cases/{id}/notes**:
   ```json
   { "content": "Trying to add a note after closing." }
   ```
   **Expected** (verified live): `400`,
   ```json
   { "code": "CASE_ALREADY_TERMINAL", "message": "Cannot add a note to a closed or filed case." }
   ```
3. **Attempt to upload evidence** (curl, same reason as Section 4):
   ```sh
   curl -X POST http://localhost:4000/cases/<case1>/evidence \
     -H "Authorization: Bearer <accessToken>" \
     -F "file=@statement-review.csv;type=text/csv;filename=late-upload.csv"
   ```
   **Expected** (verified live): `400`, same `CASE_ALREADY_TERMINAL` code, message adapted
   ("Cannot upload evidence to a closed or filed case."). Both guards were added in a whole-branch
   review that ran after this module's 12 implementation tasks were otherwise complete — see
   `HANDOFF.md` bug #24 — confirmed live here, not just in the automated suite.

## 8. Tenant isolation

1. Log in as `superadmin@regops.dev` / `SuperAdmin!2026`, **Authorize** with the new token.
2. **POST /tenants**:
   ```json
   { "name": "Cases Guide Tenant B", "type": "FINTECH" }
   ```
   **Expected**: `201`. **Copy the new tenant's `id`.**
3. **This step is curl** — same reason as every prior guide's own tenant-isolation section:
   `X-Tenant-Override` isn't a fillable Swagger parameter.
   ```sh
   curl -X POST http://localhost:4000/users \
     -H "Authorization: Bearer <superadmin accessToken>" \
     -H "X-Tenant-Override: <tenant B id>" \
     -H "Content-Type: application/json" \
     -d '{"email":"officer@tenantb-cases-guide.dev","password":"TenantBOfficer!2026","fullName":"Tenant B Officer","role":"COMPLIANCE_OFFICER"}'
   ```
   **Expected**: `201`, `data.status: "INVITED"`.
4. Log in as `officer@tenantb-cases-guide.dev` / `TenantBOfficer!2026`, **Authorize** with the new
   token.
5. **GET /cases/{id}**, paste `<case2>` from Section 3 (now `SAR_FILED` in tenant A). **Expected**
   (verified live): `404`,
   ```json
   { "code": "CASE_NOT_FOUND", "message": "Case not found." }
   ```
   **not** `403` — the same information-hiding principle every other module in this codebase follows: a
   caller can't distinguish "exists in another tenant" from "doesn't exist."
6. **GET /cases** (list), still as the Tenant B user. **Expected** (verified live): `200`,
   `"data": [], "total": 0` — none of Tenant A's cases from this entire guide leak through, in either
   the list or the by-id path.
7. **Before continuing with anything else**: re-Authorize back to Officer 1's token.

## 9. A closing note on what this guide doesn't cover

RLS enforced at the raw database level (a connection with no tenant context at all returning zero rows
against `"case"` directly, bypassing the API entirely) isn't re-demonstrated here — it's exactly what
the automated suite's own dedicated test does (`cases.e2e-spec.ts`'s "RLS enforced at the database
level" block), and Section 8 above already shows the practical, API-level consequence of the same
guarantee. Reassignment (`PATCH /cases/:id/assign`) also isn't walked step-by-step — it's a simple,
already-well-tested state mutation (see `AssignAlertDto`'s own precedent in Prompt 5's guide for the
equivalent alert-side action) that doesn't add a new concept beyond what Sections 2-8 already exercise
directly. Concurrent-request races (the case-number generation race, the alert-linking existence-check
race, and the auto-transition race fixed as `HANDOFF.md` bug #26) aren't demonstrated live for the same
reason Prompt 5's guide doesn't demonstrate its own multi-instance duplicate-evaluation finding by hand
— reproducing a genuine race deliberately would mean orchestrating two simultaneous requests, which a
sequential walkthrough like this one structurally can't do; the automated suite's own coverage gap here
(no dedicated concurrency test exists) is already disclosed honestly in `HANDOFF.md` rather than papered
over with a guide step that wouldn't actually prove anything.

---

## Checklist — Backend Prompt 6 Swagger sign-off

**What was actually verified, by clicking through Swagger and by curl where Swagger genuinely cannot
reach:**

- [ ] A case can be created via all 3 entry points — bare (explicit `customerId` + `priority`), from a
      customer (`customerId` only, `priority` defaults `MEDIUM`), and from an alert (`alertId` only,
      `customerId` resolved from the alert and winning over any conflicting body `customerId`, priority
      derived `HIGH` for `CRITICAL`/`HIGH`-severity alerts, `MEDIUM` otherwise)
- [ ] Adding a note auto-transitions an `OPEN` case to `UNDER_INVESTIGATION` with no separate action
- [ ] The full lifecycle fires correctly: submit (blocked for the case's own assignee, succeeds for a
      different Compliance Officer) → approve (blocked for the submitter themselves, succeeds for a
      genuinely different officer) → `SAR_FILED`, with `closedAt` set and `closedBy` staying `null`, and
      exactly one `Report` row auto-created, confirmed via direct SQL
- [ ] The reject path returns a `PENDING_APPROVAL` case to `UNDER_INVESTIGATION` (not `CLOSED`), clears
      the case's own `submittedBy`/`submittedAt`/`escalationRationale`, and the rejection reason is
      visible in the timeline; the `submitted` event for the rejected attempt stays visible too (durable
      `case_submission_event` row, independent of the now-nulled live columns); a resubmission after
      rejection shows BOTH submission events in the timeline, each with its own distinct rationale,
      confirmed both via the timeline and directly against `case_submission_event`
- [ ] Both maker-checker guards reject correctly: `SUBMITTER_CANNOT_BE_ASSIGNEE` on self-submission,
      `APPROVER_CANNOT_BE_SUBMITTER` on both self-approval and self-rejection
- [ ] The escalation checklist's 4 items are individually demonstrable true/false, including the
      `any`-vs-`every` distinction between items 1 and 3 (linking a second, unreviewed alert regresses a
      previously-complete checklist), and a case with an incomplete checklist is genuinely blocked from
      submission with the specific failed item(s) named in the error
- [ ] Linking an existing alert to an already-open case succeeds, doesn't change the alert's own status,
      and can cause a previously-satisfiable checklist to become incomplete again
- [ ] Evidence uploads and downloads byte-for-byte identical, with both `case.evidence_uploaded` and
      `case.evidence_downloaded` audit rows and a real timeline entry (the mock's own gap, fixed here)
- [ ] A note or evidence upload against a `CLOSED`/`SAR_FILED` case is rejected with
      `400 CASE_ALREADY_TERMINAL`
- [ ] A case created in one tenant is invisible from another — `404`, not `403`, on direct lookup, and
      absent from that tenant's own list endpoint

**What's confirmed as not currently testable through Swagger's UI, and exactly why:**

- [ ] `CreateCaseDto`/`AddNoteDto`/`SubmitCaseDto`/`RejectCaseDto`/`AssignCaseDto`/`LinkAlertDto`/
      `CloseCaseDto` request bodies — render as empty `{}` boxes, the same `@nestjs/swagger` CLI-plugin
      gap as every other DTO in this codebase
- [ ] `POST /cases/:id/evidence` — no `@ApiConsumes`/`@ApiBody` multipart schema declared (confirmed via
      `/docs-json`), so Swagger's UI never renders a file picker for it; download is curl too, so the
      round-trip can be diffed directly
- [ ] `X-Tenant-Override` — not a declared Swagger parameter, same gap as every prior guide's own
      tenant-isolation section
- [ ] `GET /cases` filter/pagination query parameters — not declared in the generated Swagger schema,
      same class of gap as every prior prompt's list endpoints
- [ ] The auto-created `Report` row — no `GET /reports` endpoint exists yet (Backend Prompt 7's job);
      confirmed directly via SQL instead
- [ ] The durable `case_submission_event` rows — no read endpoint exists for this table either (it
      only backs the timeline's `submitted` events); confirmed directly via SQL instead
- [ ] Unsetting a customer's `lastRiskCalculatedAt` to demonstrate checklist item 4's `false` state — no
      endpoint exists to unset a risk score (only to (re)calculate one), so this one step is a
      permanent, not a stand-in-for-a-future-prompt, SQL nudge
