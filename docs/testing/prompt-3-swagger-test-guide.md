# Swagger Test Guide — Backend Prompt 3 (Screening Module)

A pure click-by-click walkthrough of the Prompt 3 endpoints, done entirely inside the Swagger API
explorer at `http://localhost:4000/docs`. No curl, no terminal commands, and no reference to the
real web app at `localhost:3000`.

**Before you start**: `docker-compose up -d` and `pnpm dev` need to already be running, **and this
time the worker matters more than usual** — steps 7-8 below only complete because
`apps/worker`'s `async-screening` queue consumer is alive. If you only started the API on its own,
restart with plain `pnpm dev` (which starts api/web/worker together).

**Account used throughout**: `admin@demomfb.dev` / `TenantAdmin!2026` (TENANT_ADMIN, tenant "Demo
MFB Limited"). Unlike Prompt 2's guide, you won't need to switch accounts here — TENANT_ADMIN is
included in every screening endpoint's allowed-role list, including the two (`GET`/`PUT
/screening/providers`) that are otherwise TENANT_ADMIN-only.

This guide is honest about a few real, verified rough edges, same as Prompt 2's guide was. Three
are Swagger documentation gaps (the underlying endpoints work correctly, they're just not fully
wired up as clickable/typed fields yet): two list endpoints have no query-parameter fields, and
three request-body DTOs render as an empty `{}` box instead of typed fields. One is a genuine,
worth-knowing **behavioral** quirk of `MockProvider` itself, not a documentation gap — it's called
out in step 7 exactly where it matters. All of these were confirmed by actually clicking through
(or, for the write-up in `HANDOFF.md`, by curling the live server) rather than assumed.

---

## 1. `POST /auth/login` — get a token, then set up "Authorize" for the rest of the guide

1. In the **auth** section, click **POST /auth/login**, then **Try it out**.
2. Paste into the request body:
   ```json
   { "email": "admin@demomfb.dev", "password": "TenantAdmin!2026" }
   ```
3. Click **Execute**.
4. **Expected**: `200`. If this account has no MFA enrolled (the default, freshly-seeded state),
   `data.accessToken` is populated directly. **If instead you see
   `{"mfaRequired": true, "mfaToken": "..."}`** (because you enabled MFA on this account while
   following the Prompt 1 guide), expand **POST /auth/verify-mfa**, click **Try it out**, and paste
   `{ "mfaToken": "PASTE_IT_HERE", "code": "123456" }` (replacing `123456` with the current code
   from your authenticator app) — that response has the real `accessToken` instead.
5. Copy whichever response's `accessToken` value.
6. Scroll to the top of the page, click **Authorize**, paste the token in, click **Authorize** in
   the dialog, then **Close**.
7. **Failure mode**: if any later step unexpectedly returns `401`, your token expired (15 minutes)
   — repeat this step for a fresh one.

## 2. `POST /customers` — trigger the synchronous sanctions block

This is Section 2.1/5.1's core, non-negotiable guarantee: a confirmed sanctions match blocks
onboarding entirely, before any `Customer` row is written. `MockProvider` (this environment's only
configured screening provider — see step 13) treats any name containing `SANCTIONED` as a
confirmed hit.

1. In the **customers** section, click **POST /customers**, then **Try it out**.
2. Paste into the request body:
   ```json
   {
     "cbsCustomerId": "CBS-SCREEN-001",
     "fullName": "John SANCTIONED Doe",
     "customerType": "INDIVIDUAL",
     "kycTier": 1,
     "onboardedAt": "2024-01-15"
   }
   ```
3. Click **Execute**.
4. **Expected** (verified live against a running server, not guessed): `422`,
   ```json
   {
     "success": false,
     "error": {
       "code": "SANCTIONS_MATCH_BLOCK",
       "message": "Customer matches a sanctions list and cannot be onboarded.",
       "details": { "screeningCheckId": "<uuid>", "matchCount": 1 }
     }
   }
   ```
   **Notice what's absent**: `details` has no `listSource` or `matchName` field. That's
   deliberate — Section 5.1's info-leak guard means the API caller never learns *why* it matched,
   only that it did. A compliance officer sees the actual match details separately, via steps 3-6
   below.
5. **Copy the `screeningCheckId` value** from `error.details` — you'll need it in step 4.
6. **Failure mode**: `500`/`NO_PRIMARY_PROVIDER` here would mean this tenant has no screening
   provider configured at all — shouldn't happen on the seeded demo tenant (see step 13), but would
   happen on a tenant created without going through `TenantsService.create()`'s seeding step.

## 3. `GET /screening/checks` — find the check from step 2 (a real Swagger gap: no filter fields)

1. In the **screening** section, click **GET /screening/checks**, then **Try it out**.
2. **What you'll notice**: no input fields appear — just an **Execute** button. This endpoint
   genuinely supports filtering by `customer_id`/`check_type`/`status`/`result` plus `page`/`limit`
   pagination (confirmed by reading `ListScreeningChecksDto`, and by calling it with a real query
   string outside Swagger), but none of those parameters are declared in the generated Swagger
   schema, so there's no field to type them into. Same class of gap Prompt 2's guide already
   documented for `GET /customers`' fuzzy search.
3. Click **Execute** anyway.
4. **Expected**: `200`. The response body's `data.data` array contains every screening check for
   this tenant, newest first — scroll to find the one whose `id` matches the `screeningCheckId`
   you copied in step 2. Confirm on that entry: `"checkType": "SANCTIONS"`, `"status":
   "COMPLETED"`, `"result": "CONFIRMED_MATCH"`, and — this is the important one —
   **`"customerId": null`**. No customer was ever created for this attempt, so the check
   genuinely has nothing to attach to; it exists purely as audit evidence that the attempt
   happened and was blocked.

## 4. `GET /screening/checks/{id}` — full detail of the blocked attempt's check

1. Click **GET /screening/checks/{id}**, then **Try it out**.
2. Paste the `screeningCheckId` from step 2 into the **id** field.
3. Click **Execute**.
4. **Expected**: `200`. Beyond what step 3's list view already showed, this detail view includes
   `inputData` (the name/DOB/country actually sent to the provider) and `rawResponse` (the full,
   raw provider payload — `{"mock": true, "matches": [...]}` for `MockProvider`). This is the
   "incl. raw response" half of Section 6's spec that the list endpoint deliberately omits.
5. **Failure mode**: `404 SCREENING_CHECK_NOT_FOUND` means the id was pasted wrong, or belongs to a
   different tenant (confirmed separately not to leak cross-tenant — see
   `HANDOFF.md`'s Backend Prompt 3 Definition of Done, item 3).

## 5. `GET /screening/matches` — the pending review queue, including the blocked attempt's match

1. Click **GET /screening/matches**, then **Try it out**.
2. **Same gap as step 3**: no fillable fields, just Execute. Unlike `GET /screening/checks`,
   though, this one has a real default worth knowing — it only shows `PENDING_REVIEW` matches
   unless you could ask it for something else, matching Section 6's "pending review queue (default
   filter)" wording.
3. Click **Execute**.
4. **Expected**: `200`. Somewhere in `data.data`, find the entry whose `matchName` is `"John
   SANCTIONED Doe"` — `"checkType": "SANCTIONS"`, `"listSource": "OFAC_SDN"`, `"matchScore": 95`,
   `"reviewStatus": "PENDING_REVIEW"`, `"customerId": null` (same reasoning as step 3 — no customer
   exists to attach it to). **Copy this match's `id`** for step 6.

## 6. `GET /screening/matches/{id}` — detail of that one match

1. Click **GET /screening/matches/{id}**, **Try it out**, paste in the id from step 5.
2. Click **Execute**.
3. **Expected**: `200`, the same fields as step 5's list entry, just the one record.

## 7. `POST /customers` — a name that creates successfully, then gets flagged asynchronously

Now the other half of Section 2.1: a match that doesn't cross the CONFIRMED_MATCH threshold
doesn't block anything — the customer is created immediately, and PEP/adverse-media screening
happens **after**, in the background.

1. Click **POST /customers**, **Try it out**, and paste:
   ```json
   {
     "cbsCustomerId": "CBS-SCREEN-002",
     "fullName": "Wale POSSIBLY_SANCTIONED Balogun",
     "customerType": "INDIVIDUAL",
     "kycTier": 2,
     "onboardedAt": "2024-01-15"
   }
   ```
2. Click **Execute**.
3. **Expected**: `201`. `data.isPep` and `data.isSanctioned` are both `false` — nothing's flagged
   yet. **Copy the `id` value** — you'll reuse it for the rest of this guide.
4. **A real, verified behavioral quirk worth knowing before you continue**: `MockProvider`'s
   trigger rules (`SANCTIONED`/`POSSIBLY_SANCTIONED`/`PEP`/etc.) are matched purely against
   `fullName` — **it never looks at which check type is asking**. That means a name containing
   `PEP` would return `CONFIRMED_MATCH` on *every* check type it's run against, including the
   synchronous SANCTIONS pre-screen from step 2 — which would block the customer from ever being
   created at all, the same way step 2's `SANCTIONED` name did. There is no way to reach "customer
   created, then auto-flagged PEP via the async path" using a straightforwardly PEP-triggering
   name, because the synchronous sanctions gate catches it first. `POSSIBLY_SANCTIONED` sidesteps
   this: it only reaches `POTENTIAL_MATCH` (Section 4.3's 60-84 band), which never blocks anything
   at any check type — which is exactly why step 1's customer creation succeeded.
5. Wait a few seconds (the worker typically finishes both PEP and adverse-media checks in well
   under a second on this mock setup — a few seconds is a generous margin), then click **GET
   /screening/matches**, **Try it out**, **Execute** again.
6. **Expected**: three `PENDING_REVIEW` entries now share this customer's `id`, all with
   `matchName: "Wale POSSIBLY_SANCTIONED Balogun"`, `matchScore: 72`, `listSource:
   "UN_CONSOLIDATED"` — one from the original synchronous SANCTIONS check (step 1), and two new
   ones from the async job (`PEP` and `ADVERSE_MEDIA`). Each entry's own **`checkType`** field
   tells you directly which is which (this is read from the match's parent screening check, not
   guessed) — **find the one with `"checkType": "PEP"` and copy its `id`** for step 8, so you can
   follow along with the exact flag this guide checks in step 9.
7. **Failure mode**: only 1 match (not 3) after waiting means the worker isn't running — re-check
   `pnpm dev` started all three apps, not just the API.

## 8. `POST /screening/matches/{id}/review` — confirm a match as TRUE_POSITIVE (a real Swagger gap)

1. Click **POST /screening/matches/{id}/review**, then **Try it out**.
2. Paste the match `id` you copied in step 7 into the **id** field.
3. **What you'll notice in the request body box**: it's pre-filled with `{}`, with no labeled
   `decision`/`decisionReason` fields to fill in — `ReviewMatchDto` has no `@ApiProperty()`
   annotations, so Swagger can't render typed fields for it (same root cause as Prompt 2's
   `POST /customers/batch` gap: no CLI plugin, no explicit annotations). Replace the whole box by
   hand with:
   ```json
   { "decision": "TRUE_POSITIVE", "decisionReason": "Confirmed via secondary identity document check." }
   ```
4. Click **Execute**.
5. **Expected**: `201`, `data.reviewStatus` is now `"REVIEWED"`, `data.decision` is
   `"TRUE_POSITIVE"`, `data.reviewedBy` is populated with your user id.
6. Now click **GET /customers/{id}** (in the **customers** section), **Try it out**, paste in the
   customer id from step 7.
7. **Expected**: `200`, `data.isPep` is now **`true`**, and `data.riskLevel` is now **`"CRITICAL"`**
   — reviewing a match as TRUE_POSITIVE doesn't just record a decision, it flips the real customer
   flag and forces an immediate re-score (Section 6.1), exactly the same as any other confirmed
   PEP/sanctions detection would.
8. **Failure mode**: `isPep` still `false` after this would mean you reviewed a match that wasn't
   actually the `PEP` one from step 7 — `SANCTIONS`/`ADVERSE_MEDIA` matches have their own separate
   (or, for adverse media, no) flag-setting behavior; re-check which `id` you pasted.

## 9. `POST /screening/matches/{id}/review` again — decisions are final

1. Click **POST /screening/matches/{id}/review** again, **Try it out**, same `id` as step 8.
2. Paste any body, e.g. `{ "decision": "FALSE_POSITIVE", "decisionReason": "changed my mind" }`.
3. Click **Execute**.
4. **Expected**: `409`,
   `{"success":false,"error":{"code":"MATCH_ALREADY_REVIEWED","message":"This match has already been reviewed. Decisions are final — start a new manual screen to reverse one."}}`.

## 10. `POST /screening/matches/{id}/review` without a reason — validation still enforced

1. Pick one of the *other* two matches from step 7 (still `PENDING_REVIEW`) and paste its `id`.
2. Replace the body with `{ "decision": "FALSE_POSITIVE" }` — no `decisionReason` at all.
3. Click **Execute**.
4. **Expected**: `400`,
   ```json
   {
     "success": false,
     "error": {
       "code": "BadRequestException",
       "message": "decisionReason must be longer than or equal to 1 characters, decisionReason must be a string",
       "details": ["decisionReason must be longer than or equal to 1 characters", "decisionReason must be a string"]
     }
   }
   ```
   Note the `code` here is the generic `BadRequestException`, not a hand-written code like step
   2's `SANCTIONS_MATCH_BLOCK` — this one comes straight from the global `ValidationPipe`
   rejecting the DTO, not a manually-thrown exception with its own `code` field.

## 11. `POST /screening/customers/{id}/sanctions` — an on-demand re-check on an existing customer

Distinct from step 2's onboarding pre-screen: this re-checks a customer that **already exists**, so
it never blocks anything — a hit here just flags the customer, the same way a scheduled
re-screen would (Section 5.3), not the same way onboarding does.

1. Click **POST /screening/customers/{id}/sanctions**, **Try it out**, and paste the customer id
   from step 7 into **id**.
2. **No request body needed** — this endpoint re-screens using the customer's own already-stored
   fields, not anything you supply.
3. Click **Execute**.
4. **Expected**: `201`, `data.check.result` is `"POTENTIAL_MATCH"` (same `POSSIBLY_SANCTIONED`
   name as before) — and, if you run this again within an hour, you'll get back the exact same
   `check.id` and timestamps as the very first time, not a fresh one. That's Section 5.5's dedup
   window working as intended: an identical input on the same customer within an hour reuses the
   cached result instead of calling the provider again.

## 12. `POST /screening/customers/{id}/screen` — manual async re-screen (same Swagger gap as step 8)

1. Click **POST /screening/customers/{id}/screen**, **Try it out**, paste the same customer id.
2. **Same empty-`{}`-box gap as step 8** — `ManualScreenDto` also has no `@ApiProperty()`
   annotations. Leave the body as `{}` (both fields are optional; omitting `checkTypes` defaults to
   `["PEP", "ADVERSE_MEDIA"]` per Section 5.4), or type in
   `{ "checkTypes": ["PEP"] }` to request just one.
3. Click **Execute**.
4. **Expected**: `201`, `{"success":true,"data":{"queued":true,"checkTypes":["PEP","ADVERSE_MEDIA"]}}`
   (or whichever `checkTypes` you sent). This endpoint is **always** async regardless of which
   check types you ask for — there's no equivalent of step 2's blocking behavior here, since
   Section 5.4 describes this action as "always async."

## 13. `GET /screening/providers` — confirm the demo tenant's seeded configuration

1. Click **GET /screening/providers**, **Try it out**, **Execute** (no fields to fill in — this
   one genuinely takes no parameters, not a gap).
2. **Expected**: `200`, an array of 3 entries — one each for `SANCTIONS`/`PEP`/`ADVERSE_MEDIA`, all
   `"provider": "MOCK"`, `"isPrimary": true`, `"isFallback": false`. This is exactly what made every
   step above work without any manual setup: every new tenant gets `MockProvider` seeded as primary
   automatically (Section 11's Definition of Done), and this environment being non-production is
   why it's `MOCK` and not `SMILE_ID`/`PREMBLY`.
3. **Note what's absent**: no `credentialsRef` or `config` field anywhere in the response —
   deliberate (Section 7.4: a provider's credential reference should never round-trip to any
   client, not even TENANT_ADMIN).

## 14. `PUT /screening/providers` — TENANT_ADMIN-only, with a real Swagger gap

1. Click **PUT /screening/providers**, **Try it out**.
2. **Same empty-`{}`-box gap as steps 8/12** — `ConfigureProvidersDto` has no `@ApiProperty()`
   annotations either. Replace the box by hand with:
   ```json
   {
     "providers": [
       { "checkType": "SANCTIONS", "provider": "MOCK", "isPrimary": true, "isFallback": false, "credentialsRef": "env://MOCK_PROVIDER_UNUSED" },
       { "checkType": "PEP", "provider": "MOCK", "isPrimary": true, "isFallback": false, "credentialsRef": "env://MOCK_PROVIDER_UNUSED" },
       { "checkType": "ADVERSE_MEDIA", "provider": "MOCK", "isPrimary": true, "isFallback": false, "credentialsRef": "env://MOCK_PROVIDER_UNUSED" }
     ]
   }
   ```
   (this replaces the tenant's config with the same values it already had — safe to run, nothing
   else in this guide depends on any different configuration).
3. Click **Execute**.
4. **Expected**: `200`, the same 3-entry array as step 13, with fresh `id`s — this endpoint fully
   replaces the tenant's provider configuration in one call, not a partial patch.
5. **Now confirm the role restriction.** Click **Authorize**, **Logout** the current session, log
   in fresh (repeat step 1) as `compliance@demomfb.dev` / `Compliance!2026`, and re-Authorize with
   that token.
6. Click **PUT /screening/providers** again, **Try it out**, paste the same body from step 2,
   **Execute**.
7. **Expected**: `403`,
   `{"success":false,"error":{"code":"FORBIDDEN_ROLE","message":"Your role does not have access to this resource."}}`
   — unlike every other screening endpoint in this guide, provider configuration is TENANT_ADMIN
   only; COMPLIANCE_OFFICER can review matches and run re-checks, but can't change which provider
   the tenant screens against.
8. **Before continuing**: re-Authorize back to the TENANT_ADMIN token (repeat step 1) for the
   remaining steps.

## 15. `POST /customers` — fail-closed on a provider outage, no special setup needed

Section 4.5/10.4's other non-negotiable: if the configured provider is unreachable, sanctions
screening fails **closed**, not open. `MockProvider` simulates an outage for any name containing
`TIMEOUT_TEST` — and because the demo tenant's `SANCTIONS` config (step 13) has no fallback
provider configured, this reaches the real fail-closed path with nothing extra to set up.

1. Click **POST /customers**, **Try it out**, and paste:
   ```json
   {
     "cbsCustomerId": "CBS-SCREEN-003",
     "fullName": "TIMEOUT_TEST Ltd",
     "customerType": "CORPORATE",
     "kycTier": 1,
     "onboardedAt": "2024-01-15"
   }
   ```
2. Click **Execute**. **This one takes a few seconds** — the orchestrator genuinely retries the
   (simulated-failing) primary provider with real backoff delays before giving up.
3. **Expected** (verified live): `503`,
   ```json
   {
     "success": false,
     "error": {
       "code": "SCREENING_PROVIDER_UNAVAILABLE",
       "message": "Sanctions screening is temporarily unavailable. Please retry shortly — customer creation cannot proceed without it.",
       "details": { "screeningCheckId": "<uuid>" }
     }
   }
   ```
   No `Customer` row is created — confirmed the same way step 2 was, by checking `GET /customers`'
   `data.meta.total` is unchanged before/after.
4. **Failure mode**: a `201` here would be a serious regression — Section 4.5 is explicit that a
   screening provider being down must never "fail open" and let a sanctions check be silently
   skipped.

## 16. `GET /audit-logs` — confirm every new action type actually landed

1. In the **audit** section, click **GET /audit-logs**, **Try it out**, type `100` into **limit**,
   click **Execute**.
2. **Expected**: `200`. Among the entries, confirm you can find (scrolling through `data`):
   - `customer.create.blocked` — from step 2, `afterState.screeningCheckId` matching that step's id
   - `screening.check.completed` — several of these, one per check that ran across this guide
     (steps 2, 7, 11, 12, 15)
   - `screening.match.reviewed` — from steps 8-10, `afterState.decision` showing
     `TRUE_POSITIVE`/`FALSE_POSITIVE`
   - `customer.sanctions_flagged` or `customer.pep_flagged` — **not** from step 8 (that one's
     `customer.pep_confirmed`, a related but different action for the human-reviewed path — see
     `HANDOFF.md`'s Section 8 events table); if you want to see a `*_flagged` action specifically,
     it comes from the automated (async/scheduled) detection path, which none of this guide's
     steps happen to trigger since step 7's demonstration deliberately used a `POTENTIAL_MATCH`
     name (see step 7's note on why a straightforward auto-flag isn't reachable this way through
     Swagger alone).
3. **Failure mode**: a missing `customer.create.blocked` or `screening.check.completed` entry
   despite step 2 clearly returning a `422` would be a real regression — these are supposed to be
   written even when (especially when) the request as a whole fails.

## 17. A closing note on what this guide doesn't cover: scheduled per-tier re-screening

Screening doesn't only run at onboarding or on-demand (steps 2/7/11/12/15) — `RescreenSchedulerService`
also runs three recurring `@nestjs/schedule` cron jobs with no HTTP endpoint at all, by design: daily
at 01:00 (`HIGH`/`CRITICAL` customers, SANCTIONS + PEP), weekly on Mondays at 01:00 (`MEDIUM`,
SANCTIONS + PEP), and monthly on the 1st at 01:00 (`LOW`, SANCTIONS only). Each tick enqueues one job
per active tenant onto the `RESCREEN_QUEUE` for `apps/worker` to actually process — there's nothing to
click for this in Swagger, since it's a background job on a timer, not a request/response endpoint,
so this guide doesn't attempt to demonstrate it.

Unlike Prompt 2's equivalent closing note, this isn't fully backed by an automated test either. The
*downstream* work — what actually happens once a rescreen job is dequeued — is genuinely tested
(`processRescreenJob` in `apps/worker`, 5 cases in `apps/worker/test/screening.e2e-spec.ts`). But the
producer side — `RescreenSchedulerService`'s three `@Cron` triggers and `RescreenQueueService`'s
per-tenant `enqueue` fan-out — has **zero test coverage**: no unit test, no e2e test, referenced in no
test file in the repo at all (confirmed by grepping `apps/api/test/`, `apps/worker/test/`, and for any
`.spec.ts` alongside the scheduler/queue source). `risk-rescoring.e2e-spec.ts` covers the analogous
rescoring cron from Prompt 2 end-to-end; no `rescreen`-named equivalent exists for the scheduling/
enqueue half here. So the honest statement is narrower than "verified by automated tests instead":
it's **not testable through Swagger, and only half-covered by automated tests** — the cron-trigger and
enqueue logic is a real gap, not just a guide limitation, and worth tracking as a Prompt 3 follow-up
rather than silently assumed covered (see `HANDOFF.md`'s Known Issues section for the full writeup).

---

## Checklist — Backend Prompt 3 Swagger sign-off

**What was actually verified by clicking through Swagger:**

- [ ] A `SANCTIONED` name blocks customer creation with `422 SANCTIONS_MATCH_BLOCK`, no PII
      (`listSource`/`matchName`) leaked in the response, no `Customer` row created
- [ ] The resulting `ScreeningCheck` (customer_id `null`) and `ScreeningMatch`
      (`PENDING_REVIEW`) are both independently visible via `GET /screening/checks(/:id)` and
      `GET /screening/matches(/:id)`
- [ ] A `POSSIBLY_SANCTIONED` name creates the customer normally, and the async worker produces 3
      `PENDING_REVIEW` matches (one per check type) within seconds
- [ ] Reviewing a match `TRUE_POSITIVE` flips the customer's real flag (`isPep`) and forces an
      immediate re-score to `CRITICAL`
- [ ] A second review of the same match returns `409 MATCH_ALREADY_REVIEWED`; a review with no
      `decisionReason` returns `400`
- [ ] `POST /screening/customers/{id}/sanctions` re-checks an existing customer without blocking,
      and demonstrates the 1-hour dedup window
- [ ] `POST /screening/customers/{id}/screen` always queues asynchronously regardless of requested
      check types
- [ ] `GET /screening/providers` shows the seeded `MOCK` config; `PUT /screening/providers`
      succeeds for TENANT_ADMIN and `403`s for COMPLIANCE_OFFICER
- [ ] A `TIMEOUT_TEST` name fails closed with `503`, not open — no `Customer` row created, on the
      demo tenant's actual configuration, no special setup
- [ ] `GET /audit-logs` shows real `audit_log` rows for `customer.create.blocked` and
      `screening.check.completed`, not just in-process events

**What's confirmed as not currently testable through typed Swagger fields, and exactly why:**

- [ ] `GET /screening/checks` / `GET /screening/matches` filter parameters (`check_type`,
      `result`, `review_status`, etc.) — not declared in the generated Swagger schema, so there's
      no field to type them into (same class of gap as Prompt 2's `GET /customers` search)
- [ ] `ManualScreenDto`/`ReviewMatchDto`/`ConfigureProvidersDto` request bodies — all three render
      as an empty `{}` box with no labeled fields; the correct JSON has to be typed in by hand
      (this guide gives you the exact bodies to paste at each relevant step)
- [ ] A customer reaching "created, then auto-flagged PEP via the async path with no human
      review" — not a Swagger gap but a real `MockProvider` design limitation: its trigger rules
      don't distinguish check types, so any name that would auto-confirm PEP also auto-confirms
      (and blocks) the synchronous sanctions pre-screen first (see step 7)
- [ ] Scheduled daily/weekly/monthly per-tier re-screening — these are cron jobs with no HTTP
      endpoint by design, not something a Swagger click could ever exercise; unlike Prompt 2's
      analogous rescoring cron, the trigger/enqueue side here has **no automated test covering it
      at all** (only the downstream dequeued-job work is tested — see step 17) — a real gap, not
      just a testing-guide limitation
