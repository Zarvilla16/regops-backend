# Swagger Test Guide — Backend Prompt 2 (Customer + Risk Rating Module)

A pure click-by-click walkthrough of the Prompt 2 endpoints, done entirely inside the Swagger API
explorer at `http://localhost:4000/docs`. No curl, no terminal commands, and no reference to the
real web app at `localhost:3000`.

**Before you start**: `docker-compose up -d` and `pnpm dev` need to already be running so that
`http://localhost:4000/docs` loads, and the worker process needs to be up too (`pnpm dev` starts
it alongside the api/web apps — if you only started the API on its own, restart with plain
`pnpm dev`).

**Account used throughout**: `admin@demomfb.dev` / `TenantAdmin!2026` (TENANT_ADMIN, tenant "Demo
MFB Limited"). Customer/risk write endpoints are restricted to TENANT_ADMIN/COMPLIANCE_OFFICER —
logging in as SUPER_ADMIN here will get you `403`s.

This guide is also honest about a few real, verified rough edges. Two are minor gaps in **this
module's Swagger documentation** specifically (the underlying endpoints behave correctly, they're
just not fully wired up as clickable fields in Swagger yet). One is more fundamental: tenant
risk-factor configuration has **no REST endpoint at all** yet, anywhere — not a documentation gap,
a genuine absence of an API surface. All of these are called out explicitly, with the actual
response you'll really see where one exists, rather than glossed over.

---

## 1. `POST /auth/login` — get a token, then set up "Authorize" for the rest of the guide

1. In the **auth** section, click **POST /auth/login**, then **Try it out**.
2. Paste into the request body:
   ```json
   { "email": "admin@demomfb.dev", "password": "TenantAdmin!2026" }
   ```
3. Click **Execute**.
4. **Expected**: `200`. If this account has no MFA enrolled, the response body's `data` object
   has a real `accessToken` directly. **If instead you see
   `{"mfaRequired": true, "mfaToken": "..."}`** (because you enabled MFA on this account while
   following the Prompt 1 guide), expand **POST /auth/verify-mfa**, click **Try it out**, and
   paste `{ "mfaToken": "PASTE_IT_HERE", "code": "123456" }` (replacing `123456` with the current
   code from your authenticator app) — that response will contain the real `accessToken` instead.
5. Copy whichever response's `accessToken` value.
6. Scroll to the top of the page, click **Authorize**, paste the token into the field, click
   **Authorize** in the dialog, then **Close**.
7. Every "Execute" click below now automatically includes this token — no need to repeat this.
8. **Failure mode**: if any later step in this guide unexpectedly returns `401`, your token has
   expired (15 minutes) — just repeat this step for a fresh one.

## 2. `POST /customers` — create a customer and confirm the risk score is computed automatically

1. In the **customers** section, click **POST /customers**, then **Try it out**.
2. Paste into the request body:
   ```json
   {
     "cbsCustomerId": "CBS-TEST-0001",
     "fullName": "John Smith",
     "bvn": "12345678901",
     "customerType": "INDIVIDUAL",
     "occupation": "Trader",
     "country": "NG",
     "kycTier": 2,
     "onboardedAt": "2024-01-15"
   }
   ```
3. Click **Execute**.
4. **Expected**: `201`. In the response body's `data` object, `riskScore` and `riskLevel` are
   **already populated** — `"riskScore": 65, "riskLevel": "HIGH"` — even though you never sent
   those fields. That's the risk engine's 6-factor scoring running automatically on creation
   (`INDIVIDUAL` scores 20, `"Trader"` matches a medium-risk occupation keyword for 30, `NG` scores
   0, KYC tier 2 scores 15 — summing to 65, which bands to `HIGH`). Also confirm
   `"bvn": "*******8901"` in the response — masked by default, not the raw value you sent.
5. **Copy the `id` value from the response** — you'll need to paste it into a path field in every
   step below.
6. **Failure mode**: `409` with `"code": "CUSTOMER_CBS_ID_TAKEN"` means this exact customer was
   already created in an earlier run of this guide — either reuse that customer's `id` for the
   rest of this guide, or change `cbsCustomerId` and try again. `riskScore: null` would mean the
   tenant's default risk factor configuration didn't seed correctly.

## 3. `GET /customers` — confirm the customer appears (with a documented Swagger gap on search)

1. Click **GET /customers**, then **Try it out**.
2. **What you'll notice**: no input fields appear at all here — just an "Execute" button. This is
   a real, minor gap in this endpoint's Swagger documentation: the API genuinely supports
   typo-tolerant fuzzy name search and filtering via query parameters (e.g. `?q=jhon` would still
   match "John Smith" despite the misspelling), but those parameters aren't currently declared in
   Swagger, so there's no field to type a search term into. **This specific fuzzy-search behavior
   can't be exercised by clicking through Swagger right now** — it's verified instead by this
   project's automated test suite (see `HANDOFF.md`'s Backend Prompt 2 section, which documents
   the exact threshold-tuning behind it). What you *can* still confirm here is the plain,
   unfiltered list.
3. Click **Execute** anyway.
4. **Expected**: `200`. The response body's `data` object contains another `data` array (a
   list-inside-a-list — that's just the pagination wrapper) plus a `meta` object with
   `page`/`limit`/`total`. Scroll through the inner array and confirm your "John Smith" customer
   from step 2 is present.

## 4. `PATCH /customers/{id}` — update a risk-relevant field and confirm an automatic re-score

1. Click **PATCH /customers/{id}**, then **Try it out**.
2. An **id** field appears — paste in the customer `id` from step 2.
3. Replace the request body with:
   ```json
   { "occupation": "cash-intensive retail", "country": "IR" }
   ```
4. Click **Execute**.
5. **Expected**: `200`. `occupation` and `country` are both scoring-relevant fields, so the risk
   score recalculates automatically: `"cash-intensive"` matches a high-risk occupation keyword
   (60), and `IR` is on the FATF blacklist (100) — summed together that's well past 100, and the
   score is capped there. Confirm the response's `riskLevel` is now `"CRITICAL"` and `riskScore`
   is `100`.
6. **Failure mode**: if `riskLevel`/`riskScore` didn't change, double-check the request body was
   actually replaced (not merged with the old one) before clicking Execute.

## 5. `GET /customers/{id}/risk-history` — confirm 2+ entries in the scoring trail

1. In the **risk** section, click **GET /customers/{id}/risk-history**, then **Try it out**.
2. Three fields appear: paste the customer `id` into **id**, type `1` into **page**, and type `25`
   into **limit**.
3. Click **Execute**.
4. **Expected**: `200`, `"total": 2`. In the `data` array, the newest entry (first in the list)
   shows `"trigger": "CUSTOMER_UPDATED"`, `"score": 100`, `"level": "CRITICAL"`, with
   `previousScore`/`previousLevel` matching step 2's original values (65/HIGH). The older entry
   shows `"trigger": "INITIAL"`, `"score": 65`, `"level": "HIGH"`, `previousScore: null`,
   `previousLevel: null`.
5. **Failure mode**: `total: 1` would mean step 4's update didn't actually count as
   scoring-relevant — re-check which fields you sent.

## 6. Tenant risk-factor configuration — no endpoint exists to test yet

The risk engine's per-tenant, per-factor weights and settings (the numbers behind step 2's
`INDIVIDUAL` = 20, `"Trader"` = 30, KYC tier 2 = 15, and so on) are real and genuinely
tenant-tunable data — they live in a `risk_factor_config` database table, seeded automatically for
every tenant when it's created. **But there is currently no REST endpoint anywhere to view or
update them.** This isn't a Swagger documentation gap like the ones elsewhere in this guide — it's
a confirmed absence: searching the running API's full OpenAPI document (`GET /docs-json`) turns up
21 total routes, and none of them mention `risk-factor-config` or anything similar. The logic
that reads this table (`RiskFactorConfigService`) is currently only called *internally* — by
customer creation/update, by the manual/scheduled re-score paths, and by tenant creation's
seeding step — never from a controller a Swagger click could reach.

**Nothing to click here.** There's no "GET /risk-factor-config" or "PATCH .../weight" row to find
in Swagger's **customers** or **risk** sections, because it was never built. If you want to see
the actual current default values without an API, they're in
`packages/risk-engine/src/default-configs.ts` (documented in `HANDOFF.md`'s Backend Prompt 2
section) — but that's reading a file, not testing an endpoint, so it's out of scope for a guide
like this one. This is worth knowing about rather than assuming it's just "somewhere in Swagger
you haven't found yet."

## 7. `POST /customers/batch` — CSV upload (a real Swagger gap: no file field exists)

1. In the **customers** section, click **POST /customers/batch**, then **Try it out**.
2. **What you'll notice**: instead of a file-picker control, you get a plain JSON text box
   (pre-filled with `{}`). This endpoint genuinely accepts a real file upload (multipart form
   data) at the HTTP level, but its Swagger documentation hasn't been annotated to describe that
   yet, so Swagger renders it as if it took a JSON body — there is no field anywhere on this page
   to attach an actual CSV file.
3. Replace the body with `{"duplicate_strategy":"skip"}` anyway and click **Execute**, just to see
   what happens when the file is missing.
4. **Expected** (verified, not guessed): `400`,
   `{"success":false,"error":{"code":"FILE_REQUIRED","message":"A CSV file ('file' field) is
   required."}}`. This is the real, correct response for a request with no file attached — it
   confirms the endpoint's validation works, even though it also confirms **this endpoint's happy
   path can't currently be driven through Swagger's UI** (there's no browser-only way to attach a
   file here, and there's no Customers page in the real web app yet either — see
   `prompt-2-manual-test-guide.md` Section A). Full CSV ingestion — including a 100,000-row
   performance benchmark — is covered by this project's automated tests instead; see
   `HANDOFF.md`'s Backend Prompt 2 section for what's actually been verified there.

## 8. `GET /customers/batch/{jobId}` — the status endpoint, with a job id that doesn't exist

Since step 7 never produced a real ingestion job (the upload itself was rejected before any job
was created), there's no real `jobId` to check the happy path with. We can still verify this
endpoint's tenant/ownership-checked lookup behaves correctly using a made-up id:

1. Click **GET /customers/batch/{jobId}**, then **Try it out**.
2. In the **jobId** field, type any made-up value, e.g. `nonexistent-job-id`.
3. Click **Execute**.
4. **Expected** (verified, not guessed): `404`,
   `{"success":false,"error":{"code":"INGESTION_JOB_NOT_FOUND","message":"Ingestion job not
   found."}}`. This confirms the endpoint correctly reports "not found" for a job id that isn't
   real (or, just as importantly per its actual implementation, one that belongs to a different
   tenant) rather than leaking any information about it.
5. **Note**: because of step 7's gap, this guide can't demonstrate the endpoint reporting a real
   `"status": "completed"` result with `succeeded`/`failed` counts — that path is exercised by the
   automated ingestion tests instead.

## 9. `GET /customers` — confirm the total is unchanged (a consequence of step 7's gap, not a bug)

1. Click **GET /customers** again (still no fillable fields — see step 3), click **Try it out**,
   then **Execute**.
2. **Expected**: `200`, and `data.meta.total` is the same as it was in step 3 — **still just the
   one customer from step 2**. This is the correct, honest outcome given step 7 never actually
   ingested any rows (the upload was rejected for missing a file before anything was queued) — it
   is not evidence of a bug in ingestion itself, which is separately verified by the automated test
   suite.

## 10. `GET /audit-logs` — confirm entries for everything that actually succeeded

1. In the **audit** section, click **GET /audit-logs**, then **Try it out**.
2. Type `50` into the **limit** field.
3. Click **Execute**.
4. **Expected**: `200`. Among the `data` entries, you should find `customer.create` (from step 2,
   with an `afterState` containing the new customer's fields) and `customer.update` (from step 4,
   with both `beforeState` and `afterState` showing the occupation/country change and the new risk
   score). You will **not** find any CSV-ingestion-related audit entries (e.g. a
   `customer.create` tagged `source: "csv_ingestion"`) — correctly, since step 7's upload never got
   past validation, so nothing was ever written for it to audit.
5. **Failure mode**: a `customer.create`/`customer.update` entry missing here despite steps 2/4
   succeeding would be a real regression — every successful write in this module is supposed to be
   audited, no exceptions.

## 11. A closing note on what this guide doesn't cover: scheduled re-scoring

The risk engine doesn't only run when a customer is created, updated, or manually rescored (steps
2/4/step-5's history) — `RescoreSchedulerService` also runs three recurring `@nestjs/schedule`
cron jobs with no HTTP endpoint at all, by design: daily at 02:00 (HIGH/CRITICAL customers),
weekly on Mondays at 03:00 (MEDIUM), and monthly on the 1st at 04:00 (LOW). There's nothing to
click for these in Swagger — they're not endpoints, they're background jobs on a timer — so this
guide doesn't attempt to demonstrate them. They're exercised directly (bypassing the clock) by the
automated e2e suite (`risk-rescoring.e2e-spec.ts`, see `HANDOFF.md`'s Backend Prompt 2 Definition
of Done table, item 5), which is the appropriate way to verify scheduled logic rather than waiting
around for a real cron tick.

---

## Checklist — Backend Prompt 2 Swagger sign-off

**What was actually verified by clicking through Swagger:**

- [ ] Login + Authorize works; subsequent requests don't need repeated auth setup
- [ ] Creating a customer returns a populated, non-null `riskScore`/`riskLevel` automatically, and
      the BVN is masked in the response
- [ ] The new customer appears in a plain `GET /customers` call
- [ ] Updating occupation/country triggers an automatic re-score to `CRITICAL`/`100`
- [ ] `GET /customers/{id}/risk-history` shows exactly 2 correctly-ordered entries with the right
      `trigger`/`previousScore`/`previousLevel` values
- [ ] Confirmed (with the real, verified response) that CSV upload can't currently be completed
      through Swagger — `400 FILE_REQUIRED` — because no file-picker field is exposed
- [ ] Confirmed the batch status endpoint correctly 404s (`INGESTION_JOB_NOT_FOUND`) for a
      nonexistent job id
- [ ] `GET /audit-logs` shows entries for the customer create/update, and correctly shows nothing
      for the CSV step that never succeeded

**What's confirmed as not currently testable through the browser, and exactly why:**

- [ ] Fuzzy/typo-tolerant name search (`?q=...`) — the parameter isn't declared in Swagger for
      `GET /customers`, so there's no field to type a search term into (verified by the automated
      test suite instead)
- [ ] CSV batch upload's happy path — no file-picker field exists on `POST /customers/batch` in
      Swagger (renders as an empty JSON box instead); confirmed the real `400 FILE_REQUIRED`
      response this produces, rather than assuming it
- [ ] The batch status endpoint's happy path (`"status": "completed"` with real `succeeded`/
      `failed` counts) — unreachable as a direct consequence of the CSV upload gap above, since no
      real job can be created to check; confirmed the endpoint's `404` behavior for a nonexistent
      job id instead
- [ ] Tenant risk-factor configuration (viewing or updating a factor's weight) — **no REST
      endpoint exists for this at all**, confirmed against the live OpenAPI document (21 total
      routes, none related); this is a gap in the API surface itself, not in Swagger's
      documentation of an existing endpoint
- [ ] Scheduled daily/weekly/monthly re-scoring — these are cron jobs with no HTTP endpoint by
      design, not something a Swagger click could ever exercise; verified by the automated e2e
      suite instead (see `HANDOFF.md`)
