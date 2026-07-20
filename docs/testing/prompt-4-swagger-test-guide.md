# Swagger Test Guide — Backend Prompt 4 (Transactions Module)

Mostly a click-by-click walkthrough inside the Swagger API explorer at `http://localhost:4000/docs`
— but unlike every prior prompt's guide, **two things in this module genuinely cannot be done
through Swagger's UI at all**, not just "no typed field exists for it": webhook requests require an
HMAC-SHA256 signature computed over the exact raw request bytes, and Swagger has no capability to
compute one regardless of how the endpoint is documented; the SFTP-inbox upload endpoint has no
declared request body in Swagger at all (confirmed against the live `/docs-json`, same root cause as
`POST /customers/:id/photo`'s gap in Prompt 3.5's guide). Both are done via `curl` instead, called
out explicitly at the point they happen, exactly the way Prompt 3.5's guide disclosed its one
curl-only step rather than silently working around it.

Every step below — including the two curl ones — was actually run against a live `docker-compose
up -d` + `pnpm dev` instance while writing this guide, not just described from reading the code.
Real response bodies, real timings, and one real bug this walkthrough found and fixed are recorded
below, not guessed.

**Before you start**: `docker-compose up -d` and `pnpm dev` need to already be running (api + worker
+ web together — the worker matters here more than in any prior guide, since it's what actually
polls the SFTP-emulated inbox and processes both ingestion paths). You'll also need a terminal with
`curl` and `openssl` available (both ship with Git Bash on Windows, and natively on macOS/Linux) for
the two curl-only steps.

**Account used throughout**: `admin@demomfb.dev` / `TenantAdmin!2026` (TENANT_ADMIN, tenant "Demo
MFB Limited") for everything except the tenant-isolation section at the end, which additionally
needs `superadmin@regops.dev` / `SuperAdmin!2026` (seeded by `pnpm db:seed`) to create a second
tenant.

**A real, disclosed gap this guide runs into immediately**: there is currently **no REST endpoint
anywhere to configure a tenant's webhook secret** (`tenant.config.transactions.webhookSecret`) —
confirmed against the live `/docs-json` (no `tenant-config`-shaped route exists, same class of
absence as Prompt 2's risk-factor-config gap). Section 3 below sets it via a direct SQL `UPDATE`
against the dev Postgres instead — a one-time setup step, not something a real tenant admin could
self-serve today.

---

## 1. `POST /auth/login` — get a token, then set up "Authorize"

1. Open `http://localhost:4000/docs`. In the **auth** section, click **POST /auth/login**, **Try it
   out**, and paste:
   ```json
   { "email": "admin@demomfb.dev", "password": "TenantAdmin!2026" }
   ```
2. Click **Execute**. **Expected**: `200`, `data.accessToken` populated directly (this account has
   no MFA enrolled by default — if you see `mfaRequired: true` instead because you enabled MFA
   following an earlier guide, follow **POST /auth/verify-mfa** the same way those guides describe).
3. Copy `data.accessToken`, click **Authorize** (top of the page), paste it in, click **Authorize**,
   then **Close**. Every request below now includes it automatically.
4. **Also copy `data.user.tenantId`** — you'll need it verbatim for the curl steps (Swagger's
   `Authorize` step doesn't help those, since they don't carry a JWT at all; see Section 3).
5. **Failure mode**: a `401` on any later step means the token expired (15 minutes) — repeat this
   step for a fresh one.

## 2. `POST /customers` — create a customer to run transactions against

1. In the **customers** section, click **POST /customers**, **Try it out**, and paste:
   ```json
   {
     "cbsCustomerId": "CBS-TXN-GUIDE-001",
     "fullName": "Amaka Guide Customer",
     "customerType": "INDIVIDUAL",
     "occupation": "Trader",
     "country": "NG",
     "kycTier": 2,
     "onboardedAt": "2024-01-15"
   }
   ```
2. Click **Execute**. **Expected**: `201`. Confirmed live: `riskScore: 65`, `riskLevel: "HIGH"`
   (same 6-factor scoring Prompt 2's guide walks through — `Trader` is a medium-risk occupation
   keyword). **Copy the `id` value** — this is `customerId` for every step below.
3. **Failure mode**: `409 CUSTOMER_CBS_ID_TAKEN` means this exact customer already exists from an
   earlier run of this guide — reuse that customer's `id`, or change `cbsCustomerId`.

## 3. SFTP-emulated inbox — uploading a valid file, and watching it get processed

No real SFTP/SSH server exists in this sandbox (see `HANDOFF.md`'s Prompt 4 Deviations) — the
"SFTP path" is emulated through `FileStorage`: `POST /transactions/sftp-inbox` stands in for the
tenant dropping a file, and `apps/worker`'s `pollSftpInboxes` (a repeatable job, every 5 minutes
during 07:00-22:00 Africa/Lagos, every 30 minutes otherwise) is what actually discovers and
processes it — not the upload itself.

1. **A real Swagger gap, confirmed via the live `/docs-json`**: click **POST
   /transactions/sftp-inbox**, **Try it out**. No file-picker (or any field at all) renders — this
   operation has no declared request body in Swagger whatsoever, same root cause as Prompt 3.5's
   `POST /customers/:id/photo` gap (the `@nestjs/swagger` CLI plugin isn't enabled). **This step has
   to be done via curl.**
2. Create a file named exactly `transactions-20260720-001.csv` (the filename pattern is
   `transactions-YYYYMMDD-NNN.csv` — spec Section 5.2) with this content:
   ```csv
   cbs_transaction_id,customer_cbs_id,account_number,amount,currency,type,channel,occurred_at
   GUIDE-TXN-001,CBS-TXN-GUIDE-001,0201234567,50000.00,NGN,CREDIT,MOBILE,2026-07-20T09:00:00.000Z
   ```
   (use the `customer_cbs_id` from step 2 if you changed it there).
3. Upload it:
   ```sh
   curl -X POST http://localhost:4000/transactions/sftp-inbox \
     -H "Authorization: Bearer <your accessToken>" \
     -F "file=@transactions-20260720-001.csv;type=text/csv"
   ```
4. **Expected** (verified live): `201`, `{"success":true,"data":{"filename":"transactions-20260720-001.csv","status":"uploaded"}}`.
   Note what this response does **not** tell you: whether the file's name is even valid, or whether
   it's been processed at all — the upload only stores bytes; validation and processing both happen
   later, at poll time.
5. **Wait for the next poll tick** — up to 5 minutes during business hours (Africa/Lagos time), up
   to 30 otherwise (spec Section 5.3). While waiting, you can watch the file sitting in
   `.local-storage/tenants/<tenantId>/sftp-inbox/` (relative to the repo root) using your OS file
   browser or a terminal — `<tenantId>` is the value you copied in step 1.4. In this session's own
   verification run (mid-afternoon, Africa/Lagos business hours), the file sat in the inbox for a
   few minutes before the next `*/5` tick picked it up — this is the one step in this guide with a
   real, unavoidable wait, not a bug.
6. Once the file is gone from `sftp-inbox/`, back in Swagger click **GET /transactions/batches**,
   **Try it out**, **Execute** (no fillable fields — see the note in step 8 below). **Expected**:
   `200`, an entry with `"source": "SFTP"`, `"sourceReference": "transactions-20260720-001.csv"`,
   `"status": "COMPLETED"`, `"totalRows": 1`, `"succeededRows": 1`.
7. Confirm the file itself moved: check
   `.local-storage/tenants/<tenantId>/sftp-processed/transactions-20260720-001.csv` now exists (and
   `sftp-inbox/` is empty again).
8. **A real Swagger gap, same class as every prior prompt's list endpoints**: `GET
   /transactions/batches` genuinely supports `page`/`limit` (spec Section 10), but no fields render
   in Swagger for them — confirmed via `/docs-json` (`parameters: []`). Not fixable by clicking
   around; this is a documentation gap, not missing behavior.
9. **A bug this exact step found and a fix that's already landed**: the first time this guide was
   walked, `GET /transactions/batches` 500'd with `invalid input syntax for type uuid: "batches"`.
   Root cause: `TransactionsModule`'s controller registration order had `TransactionsController`
   (`GET /transactions/:id`) ahead of `BatchesController` (`GET /transactions/batches`) — Nest/Express
   match routes in registration order, so `"batches"` was being swallowed as the `:id` path param
   before `BatchesController`'s more specific route ever got a chance. Fixed by reordering
   `TransactionsModule`'s `controllers` array (`BatchesController` first) and covered by a new e2e
   regression test (`transactions.e2e-spec.ts`, "GET /transactions/batches is not swallowed by GET
   /transactions/:id's route"). If you see this exact 500 rather than a `200`, your checkout
   predates that fix.

## 4. SFTP-emulated inbox — a misnamed file gets quarantined, no batch created

1. Create a file with any name that does **not** match `transactions-YYYYMMDD-NNN.csv`, e.g.
   `wrong-filename.csv`, containing anything (its content is never even read — the filename check
   happens before any parsing).
2. Upload it the same way as step 3.3:
   ```sh
   curl -X POST http://localhost:4000/transactions/sftp-inbox \
     -H "Authorization: Bearer <your accessToken>" \
     -F "file=@wrong-filename.csv;type=text/csv"
   ```
3. **Expected**: `201` — the upload endpoint itself doesn't validate the filename (spec Section 5.2:
   "files not matching the pattern are moved to quarantine immediately" — by the poller, not the
   upload).
4. Wait for the next poll tick (same cadence as step 3.5).
5. **Expected** (verified live): the file disappears from `sftp-inbox/` and reappears at
   `.local-storage/tenants/<tenantId>/sftp-quarantine/wrong-filename.csv` — never processed.
6. Confirm no batch was created for it: `GET /transactions/batches` again — the total count should
   be unchanged from step 3.6 (no new `sourceReference: "wrong-filename.csv"` entry). This is
   spec Section 5.2's exact described behavior: "the MFB sees the file disappear from inbox without
   a corresponding entry in processed" — and, this guide's own addition, without one in the batch
   list either.

## 5. Webhook ingestion — configuring the secret (a real gap), then a validly-signed request

`POST /transactions/ingest` (spec Section 6) authenticates via `HMAC-SHA256(tenant's webhook secret,
timestamp + '.' + raw body)`, verified by `WebhookSignatureGuard` — not a JWT, since the caller is an
external CBS/webhook sender, not a logged-in RegOps user. Swagger cannot exercise this endpoint at
all: it has no capability to compute an HMAC over an arbitrary body, and (confirmed via
`/docs-json`) this operation declares neither a typed request body nor the custom
`X-RegOps-Signature`/`X-RegOps-Timestamp`/`X-Tenant-Id` headers as fillable parameters. **This entire
section is curl.**

1. **Set the tenant's webhook secret** (see this guide's opening note — no endpoint exists for this
   yet):
   ```sh
   docker exec regops-postgres-1 psql -U regops_admin -d regops -c \
     "UPDATE tenant SET config = '{\"transactions\": {\"webhookSecret\": \"guide-webhook-secret-2026\"}}'::jsonb WHERE id = '<tenantId>';"
   ```
   (replace `<tenantId>` with the value from step 1.4). Confirmed live: `UPDATE 1`.
2. Compute a signature and send a request:
   ```sh
   SECRET="guide-webhook-secret-2026"
   TENANT_ID="<tenantId>"
   TIMESTAMP=$(date +%s)
   BODY='{"transactions":[{"cbs_transaction_id":"GUIDE-WEBHOOK-001","customer_cbs_id":"CBS-TXN-GUIDE-001","account_number":"0201234567","amount":75000,"currency":"NGN","type":"DEBIT","channel":"POS","occurred_at":"2026-07-20T10:00:00.000Z"}]}'
   SIGNATURE=$(printf '%s' "${TIMESTAMP}.${BODY}" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')

   curl -X POST http://localhost:4000/transactions/ingest \
     -H "X-Tenant-Id: $TENANT_ID" \
     -H "X-RegOps-Timestamp: $TIMESTAMP" \
     -H "X-RegOps-Signature: sha256=$SIGNATURE" \
     -H "Content-Type: application/json" \
     -d "$BODY"
   ```
3. **Expected** (verified live): `202`,
   `{"success":true,"data":{"batchId":"<uuid>","transactionCount":1,"status":"queued"}}`. **Copy the
   `batchId`.**
4. Back in Swagger, click **GET /transactions/batches/{id}**, **Try it out**, paste the `batchId`,
   **Execute**. **Expected**: `200`, `"status": "COMPLETED"` within a couple of seconds (this path
   doesn't wait on a poll cadence — the job is enqueued and picked up by the worker immediately).
5. **Failure mode**: if step 2's `curl -d "$BODY"` re-serializes or re-orders the JSON before
   sending (some tools do this), the signature won't match what was actually transmitted and you'll
   get `401 WEBHOOK_SIGNATURE_INVALID` even with the right secret — `curl -d` with a pre-built
   string (as above) sends it verbatim, which is why the command is written that way rather than
   passing a JSON object for curl to encode itself.

## 6. Webhook ingestion — an invalid signature is rejected

1. Repeat step 5.2's `curl` command, but compute the signature with the wrong secret:
   ```sh
   BADSIG=$(printf '%s' "${TIMESTAMP}.${BODY}" | openssl dgst -sha256 -hmac "wrong-secret" | sed 's/^.* //')
   curl -X POST http://localhost:4000/transactions/ingest \
     -H "X-Tenant-Id: $TENANT_ID" \
     -H "X-RegOps-Timestamp: $TIMESTAMP" \
     -H "X-RegOps-Signature: sha256=$BADSIG" \
     -H "Content-Type: application/json" \
     -d "$BODY"
   ```
   (reuse the same `$TIMESTAMP`/`$BODY`, or generate fresh ones — either works, they just both need
   to feed the same signature computation).
2. **Expected** (verified live): `401`,
   `{"success":false,"error":{"code":"WEBHOOK_SIGNATURE_INVALID","message":"Signature verification failed."}}`.
3. **A related check worth doing while you're here**: resend step 5.2's exact command again (same
   timestamp, valid signature) but wait more than 5 minutes first, or manually set `TIMESTAMP` to
   `$(( $(date +%s) - 600 ))`. **Expected**: `401 WEBHOOK_TIMESTAMP_STALE` — confirmed live —
   protecting against replaying an old, previously-valid signed request.

## 7. `GET /transactions` and `GET /customers/{id}/transactions` — confirming visibility

1. In Swagger, click **GET /transactions**, **Try it out**, **Execute**. **A real Swagger gap, same
   class as step 3.8**: no filter fields render (`customer_id`, `account_number`, `type`, `channel`,
   `amount_min`/`amount_max`, `occurred_from`/`occurred_to`, etc. all genuinely work — spec Section
   10.1 — just none are declared in Swagger).
2. **Expected**: `200`. In `data.data`, confirm both transactions from steps 3 and 5 are present —
   `cbsTransactionId: "GUIDE-TXN-001"` (source `"SFTP"`) and `"GUIDE-WEBHOOK-001"` (source
   `"WEBHOOK"`). **Copy either entry's `id` value** — Section 9 (tenant isolation) reuses it.
3. Click **GET /customers/{id}/transactions**, **Try it out**, paste the customer `id` from step 2,
   **Execute**. **Expected**: `200`, the same two transactions, both showing `customerId` matching
   the one you pasted.

## 8. Triggering the velocity factor — a real spike, a real score, a real risk-score change

This is the one step that needs enough transaction *history* (not just one row) to actually
demonstrate a signal, so it uses a fresh customer and an 11-row webhook batch: 10 days of a
consistent ₦50,000/day baseline, then a ₦4,000,000 spike today. Typing 11 JSON objects into
Swagger's empty request-body box by hand is possible but tedious — this section uses curl for the
same practical reason step 5 does, on top of the same fundamental HMAC requirement.

1. **POST /customers** (Swagger is fine here — same as step 2):
   ```json
   {
     "cbsCustomerId": "CBS-VELOCITY-GUIDE-001",
     "fullName": "Chidi Velocity Customer",
     "customerType": "INDIVIDUAL",
     "occupation": "Teacher",
     "country": "NG",
     "kycTier": 2,
     "onboardedAt": "2024-01-15"
   }
   ```
   **Expected**: `201`, `riskScore: 45`, `riskLevel: "MEDIUM"` (confirmed live — this is the
   *baseline* score you'll compare against after the spike). **Copy this customer's `id`.**
2. Send the batch (adjust the 11 `occurred_at` dates to be 10 consecutive days ending today, with
   the last row today):
   ```sh
   SECRET="guide-webhook-secret-2026"
   TIMESTAMP=$(date +%s)
   BODY='{"transactions":[
     {"cbs_transaction_id":"VEL-GUIDE-10","customer_cbs_id":"CBS-VELOCITY-GUIDE-001","account_number":"0301234567","amount":50000,"currency":"NGN","type":"CREDIT","channel":"MOBILE","occurred_at":"2026-07-10T13:48:31.348Z"},
     {"cbs_transaction_id":"VEL-GUIDE-9","customer_cbs_id":"CBS-VELOCITY-GUIDE-001","account_number":"0301234567","amount":50000,"currency":"NGN","type":"CREDIT","channel":"MOBILE","occurred_at":"2026-07-11T13:48:31.348Z"},
     {"cbs_transaction_id":"VEL-GUIDE-8","customer_cbs_id":"CBS-VELOCITY-GUIDE-001","account_number":"0301234567","amount":50000,"currency":"NGN","type":"CREDIT","channel":"MOBILE","occurred_at":"2026-07-12T13:48:31.348Z"},
     {"cbs_transaction_id":"VEL-GUIDE-7","customer_cbs_id":"CBS-VELOCITY-GUIDE-001","account_number":"0301234567","amount":50000,"currency":"NGN","type":"CREDIT","channel":"MOBILE","occurred_at":"2026-07-13T13:48:31.348Z"},
     {"cbs_transaction_id":"VEL-GUIDE-6","customer_cbs_id":"CBS-VELOCITY-GUIDE-001","account_number":"0301234567","amount":50000,"currency":"NGN","type":"CREDIT","channel":"MOBILE","occurred_at":"2026-07-14T13:48:31.348Z"},
     {"cbs_transaction_id":"VEL-GUIDE-5","customer_cbs_id":"CBS-VELOCITY-GUIDE-001","account_number":"0301234567","amount":50000,"currency":"NGN","type":"CREDIT","channel":"MOBILE","occurred_at":"2026-07-15T13:48:31.348Z"},
     {"cbs_transaction_id":"VEL-GUIDE-4","customer_cbs_id":"CBS-VELOCITY-GUIDE-001","account_number":"0301234567","amount":50000,"currency":"NGN","type":"CREDIT","channel":"MOBILE","occurred_at":"2026-07-16T13:48:31.348Z"},
     {"cbs_transaction_id":"VEL-GUIDE-3","customer_cbs_id":"CBS-VELOCITY-GUIDE-001","account_number":"0301234567","amount":50000,"currency":"NGN","type":"CREDIT","channel":"MOBILE","occurred_at":"2026-07-17T13:48:31.348Z"},
     {"cbs_transaction_id":"VEL-GUIDE-2","customer_cbs_id":"CBS-VELOCITY-GUIDE-001","account_number":"0301234567","amount":50000,"currency":"NGN","type":"CREDIT","channel":"MOBILE","occurred_at":"2026-07-18T13:48:31.348Z"},
     {"cbs_transaction_id":"VEL-GUIDE-1","customer_cbs_id":"CBS-VELOCITY-GUIDE-001","account_number":"0301234567","amount":50000,"currency":"NGN","type":"CREDIT","channel":"MOBILE","occurred_at":"2026-07-19T13:48:31.348Z"},
     {"cbs_transaction_id":"VEL-GUIDE-SPIKE","customer_cbs_id":"CBS-VELOCITY-GUIDE-001","account_number":"0301234567","amount":4000000,"currency":"NGN","type":"CREDIT","channel":"MOBILE","occurred_at":"2026-07-20T13:48:31.348Z"}
   ]}'
   SIGNATURE=$(printf '%s' "${TIMESTAMP}.${BODY}" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')

   curl -X POST http://localhost:4000/transactions/ingest \
     -H "X-Tenant-Id: $TENANT_ID" \
     -H "X-RegOps-Timestamp: $TIMESTAMP" \
     -H "X-RegOps-Signature: sha256=$SIGNATURE" \
     -H "Content-Type: application/json" \
     -d "$BODY"
   ```
3. **Expected**: `202`, `"transactionCount": 11`. Wait a couple of seconds (the same
   near-immediate processing as step 5.4), then confirm via `GET /transactions/batches/{id}` (using
   this response's `batchId`) that `"status": "COMPLETED"`, `"succeededRows": 11`.
4. Back in Swagger, click **GET /customers/{id}/velocity-stats**, **Try it out**, paste the customer
   `id` from step 8.1, **Execute**. **Expected** (verified live):
   ```json
   {
     "customerId": "...",
     "score": 25,
     "detail": {
       "todayTotal": 4000000,
       "rollingAvg": 50000,
       "spikeDetected": true,
       "spikeScore": 25,
       "channelAnomaly": false,
       "dormancyReactivation": false,
       "historicalDayCount": 10
     }
   }
   ```
   A real, non-zero score — today's ₦4,000,000 is both more than 5× the ₦50,000 rolling average
   *and* over the ₦1,000,000 minimum (spec Section 9.2's spike condition), so `spikeScore: 25` is
   awarded (no channel anomaly or dormancy reactivation also fired, so the total is just the 25).
5. Click **GET /customers/{id}** with the same `id`. **Expected** (verified live): `riskScore: 70`,
   `riskLevel: "HIGH"` — up from step 8.1's baseline `45`/`MEDIUM`, **with no manual re-score request
   made anywhere in this guide**. This is spec Section 9.4's debounced automatic trigger: batch
   completion emitted one `transaction.ingested` event per row (11 total, all for this same
   customer, all within the same batch), the first one won the 60-second debounce lock, and by the
   time it fired the *entire* batch (spike included) was already committed, so the re-score reflects
   the full history, not a partial state.
6. Click **GET /customers/{id}/risk-history**, same `id`, **Execute**. **Expected**: the newest entry
   (first in the list) shows `"trigger": "TRANSACTION_ACTIVITY"` (a new `ScoreTrigger` value this
   prompt adds), `"previousScore": 45`, `"previousLevel": "MEDIUM"`, `"score": 70`, `"level": "HIGH"`
   — and inside `factors.TRANSACTION_VELOCITY.detail`, the exact same `spikeDetected`/`spikeScore`
   values step 4 already showed you directly.

## 9. Tenant isolation — a transaction created for one tenant is invisible to another

1. Log out (or just note you'll need a second token) and, still in Swagger, click **POST /auth/login**
   again — this time as `superadmin@regops.dev` / `SuperAdmin!2026`. **Authorize** with that token.
2. Click **POST /tenants**, **Try it out**. Same pre-existing empty-`{}`-box gap every DTO in this
   codebase has (see Prompt 2/3.5's guides) — paste by hand:
   ```json
   { "name": "Guide Test Tenant B", "type": "FINTECH" }
   ```
3. **Execute**. **Expected**: `201`. **Copy the new tenant's `id`.**
4. **Another real Swagger gap, confirmed via `/docs-json`**: `POST /users` declares zero parameters,
   so there's no field anywhere on this page to set the `X-Tenant-Override` header SUPER_ADMIN
   needs to create a user in a tenant other than their own — stock Swagger UI only renders inputs
   for parameters an endpoint actually declares, and doesn't offer a way to inject an arbitrary
   custom header on top of that. **This one step has to be curl**:
   ```sh
   curl -X POST http://localhost:4000/users \
     -H "Authorization: Bearer <superadmin accessToken>" \
     -H "X-Tenant-Override: <tenant B id from step 3>" \
     -H "Content-Type: application/json" \
     -d '{"email":"admin@tenantb-guide.dev","password":"TenantBAdmin!2026","fullName":"Tenant B Admin","role":"TENANT_ADMIN"}'
   ```
5. Run it. **Expected** (verified live): `201`, `data.tenantId` matching the tenant from step 3,
   `data.status: "INVITED"`.
6. Click **Authorize**, clear the current token, log in fresh as `admin@tenantb-guide.dev` /
   `TenantBAdmin!2026` (`POST /auth/login`, same as step 1) — **confirmed live: an `INVITED` user can
   still log in successfully**, `200` with a real `accessToken`. Re-Authorize with this new token.
7. Click **GET /transactions**, **Try it out**, **Execute**. **Expected** (verified live): `200`,
   `"data": [], "total": 0` — none of tenant A's transactions from steps 3-8 are visible.
8. Click **GET /transactions/{id}**, paste the `id` of either transaction from step 7's `GET
   /transactions` response (tenant A's — copy it from that response's `data.data[].id`), **Execute**.
   **Expected** (verified live): `404`,
   `{"success":false,"error":{"code":"TRANSACTION_NOT_FOUND","message":"Transaction not found."}}` —
   not a `403`, so a caller can't distinguish "exists in another tenant" from "doesn't exist at all",
   same information-hiding principle every other module in this codebase already follows.
9. **Before continuing with anything else**: re-Authorize back to the tenant A `admin@demomfb.dev`
   token if you want to keep exploring.

## 10. A closing note on what this guide doesn't cover

Partition maintenance (`create_transaction_partition`, the monthly-on-the-25th job) and the
100,000-row performance benchmark have no HTTP surface at all by design — the former is a Postgres
function called by a `MAINTENANCE_QUEUE` job on a timer, the latter is a throughput measurement, not
a request/response endpoint. Both are exercised directly by the automated suite instead
(`apps/worker/test/partition-maintenance.e2e-spec.ts`, and
`apps/worker/test/transaction-ingestion-benchmark.e2e-spec.ts` — opt-in via
`RUN_TRANSACTION_INGESTION_BENCHMARK=1`, **100,000 rows in 45.2s** the one time it's actually been
run — see `HANDOFF.md`'s Backend Prompt 4 Definition of Done). The `reject` vs. `auto_create_stub`
unknown-customer-resolution modes (spec Section 5.6) also aren't demonstrated here — this guide's
customers always exist before their transactions arrive; see the automated
`transaction-ingestion.e2e-spec.ts` suite for both modes exercised directly.

---

## Checklist — Backend Prompt 4 Swagger sign-off

**What was actually verified, by clicking through Swagger and by curl where Swagger genuinely
cannot reach:**

- [ ] A CSV uploaded to `POST /transactions/sftp-inbox` with a valid filename is discovered by the
      poller, processed, and moved to `sftp-processed/`; `GET /transactions/batches` shows it
      `COMPLETED`
- [ ] A misnamed file is quarantined immediately with no `IngestionBatch` created
- [ ] A validly HMAC-signed `POST /transactions/ingest` request returns `202` and completes
      asynchronously; an invalid signature returns `401 WEBHOOK_SIGNATURE_INVALID`; a stale
      timestamp returns `401 WEBHOOK_TIMESTAMP_STALE`
- [ ] Both ingested transactions appear in `GET /transactions` and `GET /customers/{id}/transactions`
- [ ] 10 days of consistent history plus a same-day spike produces a real, non-zero
      `GET /customers/{id}/velocity-stats` score with `spikeDetected: true`
- [ ] The customer's overall `riskScore`/`riskLevel` changed automatically (no manual re-score
      requested anywhere), with `GET /customers/{id}/risk-history`'s newest entry showing
      `trigger: "TRANSACTION_ACTIVITY"` and the correct `previousScore`/`previousLevel`
- [ ] A tenant B user sees zero of tenant A's transactions via `GET /transactions`, and a direct
      `GET /transactions/{id}` for tenant A's transaction returns `404`, not `403`
- [ ] A real routing bug (`GET /transactions/batches` swallowed by `GET /transactions/:id`) was
      found by this exact walkthrough and is now fixed, with a regression test added

**What's confirmed as not currently testable through Swagger's UI, and exactly why:**

- [ ] `POST /transactions/sftp-inbox`'s file upload — no request body declared in Swagger at all
      (confirmed via `/docs-json`), same class of gap as Prompt 3.5's photo upload
- [ ] `POST /transactions/ingest` in general — Swagger cannot compute an HMAC signature under any
      circumstances, regardless of how the endpoint might be annotated; this is not a documentation
      gap that better annotations would fix
- [ ] `GET /transactions`, `GET /transactions/batches`, `GET /customers/{id}/transactions` filter/
      pagination query parameters — not declared in the generated Swagger schema, same class of gap
      as every prior prompt's list endpoints
- [ ] Configuring a tenant's webhook secret — **no REST endpoint exists for this at all**, confirmed
      against the live `/docs-json`; set via a direct SQL `UPDATE` in this guide instead, the same
      kind of genuine API-surface absence as Prompt 2's risk-factor-config gap
- [ ] `reject`/`auto_create_stub` unknown-customer-resolution modes — not demonstrated in this guide
      (every customer here pre-exists its transactions); verified instead by
      `transaction-ingestion.e2e-spec.ts`
- [ ] Partition maintenance and the 100k-row benchmark — no HTTP surface by design; verified by the
      automated suite instead (see Section 10)
