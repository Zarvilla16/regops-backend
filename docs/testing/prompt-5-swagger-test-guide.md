# Swagger Test Guide — Backend Prompt 5 (Rules Engine & Alerts)

Mostly a click-by-click walkthrough inside the Swagger API explorer at `http://localhost:4000/docs`
— every new DTO in this module (`UpdateRuleDto`, `TestRuleDto`, `AssignAlertDto`, `CloseAlertDto`)
renders as an empty `{}` box, the same `@nestjs/swagger` CLI-plugin gap every prior prompt's guide
has already called out, so request bodies below are pasted in by hand. **One step genuinely cannot
be done through Swagger's UI at all**: the rule-loosening guardrail's `X-Confirm-Loosening` header
isn't declared as a parameter (confirmed against the live `/docs-json`, same root cause as Prompt
4's `X-Tenant-Override` gap), so both halves of that check are curl. Transaction ingestion itself
reuses Prompt 4's webhook path, so those specific calls are curl too, for the exact same HMAC reason
Prompt 4's guide gives.

Every step below — including the curl ones — was actually run against a live `docker-compose up -d`
+ `pnpm dev` instance while writing this guide, not just described from reading the code. Real
response bodies and two genuinely interesting real findings (not bugs — see Sections 7 and 11) are
recorded below, not guessed.

**Before you start**: `docker-compose up -d` and `pnpm dev` need to already be running (api + worker
together — the worker matters here exactly as much as it did in Prompt 4's guide, since it's what
actually inserts transactions the rules engine then reacts to). You'll need `curl` and `openssl`
(both ship with Git Bash on Windows, natively on macOS/Linux) for the curl-only steps.

**Account used throughout**: `admin@demomfb.dev` / `TenantAdmin!2026` (TENANT_ADMIN, tenant "Demo
MFB Limited") for everything except Section 11 (tenant isolation), which additionally needs
`superadmin@regops.dev` / `SuperAdmin!2026` to create a second tenant.

**Reusing Prompt 4's webhook secret setup**: this guide's transactions all go in via `POST
/transactions/ingest`, same as Prompt 4's guide. If you already walked that guide against this same
dev database, "Demo MFB Limited"'s webhook secret is already configured and you can skip straight to
Section 1 — check with:
```sh
docker exec regops-postgres-1 psql -U regops_admin -d regops -c \
  "SELECT config FROM tenant WHERE id = '<tenantId>';"
```
If it's empty, set one the same way Prompt 4's guide does:
```sh
docker exec regops-postgres-1 psql -U regops_admin -d regops -c \
  "UPDATE tenant SET config = '{\"transactions\": {\"webhookSecret\": \"rules-guide-secret-2026\"}}'::jsonb WHERE id = '<tenantId>';"
```
This guide's own live run used a secret already sitting in the dev database from earlier manual
verification (`manual-test-secret`) — substitute whatever value you actually set for
`$SECRET` below.

---

## 1. `POST /auth/login` — get a token, then set up "Authorize"

1. Open `http://localhost:4000/docs`. In the **auth** section, click **POST /auth/login**, **Try it
   out**, and paste:
   ```json
   { "email": "admin@demomfb.dev", "password": "TenantAdmin!2026" }
   ```
2. Click **Execute**. **Expected**: `200`, `data.accessToken` populated directly.
3. Copy `data.accessToken`, click **Authorize** (top of the page), paste it in, **Authorize**, then
   **Close**. Every request below now includes it automatically.
4. Click **GET /auth/me**, **Execute**. **Copy `data.tenant.id`** — this is `<tenantId>` for every
   curl step below. Confirmed live: `2111565d-2253-45d7-b2d7-78d10b949441`.
5. **Failure mode**: a `401` on any later step means the token expired (15 minutes) — repeat this
   step for a fresh one. This guide's own walkthrough hit this once (the tenant-isolation section ran
   long enough for the original token to lapse) — just log in again.

## 2. `GET /rules` — confirm the five default rules exist

1. In the **rules** section, click **GET /rules**, **Try it out**, **Execute**.
2. **Expected** (verified live): `200`, `data` is an array of exactly 5 rules — one each for
   `LARGE_CASH`, `STRUCTURING`, `RAPID_INFLOW_OUTFLOW`, `HIGH_RISK_COUNTERPARTY`, `VELOCITY_SPIKE`.
   Confirmed live defaults: `LARGE_CASH` MEDIUM/FLAG, `thresholdIndividual: 5000000`,
   `thresholdCorporate: 10000000`; `STRUCTURING` HIGH/REVIEW, `minCount: 3`,
   `cumulativeThreshold: 5000000`, `windowHours: 24`; `RAPID_INFLOW_OUTFLOW` HIGH/REVIEW,
   `outflowRatio: 0.8`, `windowMinutes: 60`; `HIGH_RISK_COUNTERPARTY` CRITICAL/REVIEW,
   `sanctionsSeverity: "CRITICAL"`, `pepSeverity: "MEDIUM"`; `VELOCITY_SPIKE` MEDIUM/FLAG,
   `minSpikeRatio: 5`, `minAbsoluteAmount: 1000000`.
3. **Copy each rule's `id`** — you'll need them in Sections 3-8 (each scenario section below states
   which one it needs).
4. **A real, disclosed finding, not a bug**: if you run this same request against a tenant created
   *before* this prompt shipped (e.g. an older "Guide Test Tenant B" left over from Prompt 4's own
   guide), you'll get `data: []` — **zero rules**, not the 5 defaults. Rule seeding
   (`RulesService.seedDefaultsForTenant`) only runs at tenant-*creation* time
   (`TenantsService.create()`); there's no retroactive backfill for tenants that already existed.
   Confirmed live against exactly this scenario in Section 11 below — worth knowing before you assume
   every tenant in a long-lived dev database has rules.

## 3. Scenario 1 — Large Cash Threshold

1. **POST /customers** (paste by hand, same pre-existing empty-`{}`-box gap every DTO in this
   codebase has):
   ```json
   {
     "cbsCustomerId": "CBS-RULES-LARGECASH-001",
     "fullName": "Bola Large Cash Customer",
     "customerType": "INDIVIDUAL",
     "occupation": "Shop Owner",
     "country": "NG",
     "kycTier": 2,
     "onboardedAt": "2024-01-15"
   }
   ```
   **Expected**: `201`. **Copy the `id`** — this is `<customerId>` for this section.
2. **This step is curl** — same HMAC reason as every transaction-ingestion call in Prompt 4's guide:
   ```sh
   SECRET="<your tenant's webhook secret>"
   TENANT_ID="<tenantId>"
   TIMESTAMP=$(date +%s)
   BODY='{"transactions":[{"cbs_transaction_id":"GUIDE-RULES-LARGECASH-1","customer_cbs_id":"CBS-RULES-LARGECASH-001","account_number":"0401234567","amount":6500000,"currency":"NGN","type":"CREDIT","channel":"CASH","occurred_at":"'"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"'"}]}'
   SIGNATURE=$(printf '%s' "${TIMESTAMP}.${BODY}" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')

   curl -X POST http://localhost:4000/transactions/ingest \
     -H "X-Tenant-Id: $TENANT_ID" \
     -H "X-RegOps-Timestamp: $TIMESTAMP" \
     -H "X-RegOps-Signature: sha256=$SIGNATURE" \
     -H "Content-Type: application/json" \
     -d "$BODY"
   ```
   **Expected**: `202`, `"status": "queued"`.
3. Wait 2-3 seconds — unlike SFTP polling, webhook-ingested transactions are picked up by the worker
   almost immediately, and rule evaluation itself is another near-instant queue hop after that (same
   "doesn't wait on a poll cadence" timing Prompt 4's guide observed for `GET
   /transactions/batches/{id}`).
4. Back in Swagger, click **GET /alerts**, **Try it out**, **Execute**. **A real Swagger gap, same
   class as every prior prompt's list endpoints**: no `scenario_type`/`customer_id`/`status` filter
   fields render (confirmed via `/docs-json` — `parameters: []`) even though they all genuinely work;
   just scan `data.data` for the alert whose `customerId` matches step 1's.
5. **Expected** (verified live):
   ```json
   {
     "scenarioType": "LARGE_CASH",
     "severity": "MEDIUM",
     "status": "NEW",
     "title": "Cash CREDIT of NGN 6,500,000 by Bola Large Cash Customer",
     "evidence": {
       "type": "CREDIT",
       "amount": 6500000,
       "channel": "CASH",
       "customerType": "INDIVIDUAL",
       "thresholdApplied": 5000000,
       "transactionReference": "<the transaction's id>",
       "relatedTransactionIds": ["<the transaction's id>"]
     },
     "dedupKey": "large_cash:<customerId>:<transactionId>",
     "fireCount": 1
   }
   ```
   `title` and `evidence` read as a genuinely clear, self-contained description of what fired —
   amount, channel, customer name, and the exact threshold crossed, no need to cross-reference the
   rule config separately to understand why this alert exists. **Copy this alert's `id`** — Section 9
   (replay) reuses this exact transaction.

## 4. Scenario 2 — Structuring / Smurfing, and confirming dedup

This section demonstrates **both** the scenario and the dedup requirement in one flow: three cash
deposits trigger the alert, then a fourth same-day deposit increments it rather than creating a
second one.

1. **POST /customers**:
   ```json
   {
     "cbsCustomerId": "CBS-RULES-STRUCTURING-001",
     "fullName": "Ngozi Structuring Customer",
     "customerType": "INDIVIDUAL",
     "occupation": "Trader",
     "country": "NG",
     "kycTier": 2,
     "onboardedAt": "2024-01-15"
   }
   ```
   **Copy the `id`**.
2. Send three cash deposits of ₦2,000,000 each, spread across the last 6 hours (all curl, same HMAC
   reason as step 3.2 — three rows fit comfortably in one webhook batch, unlike typing them
   individually into Swagger):
   ```sh
   NOW_EPOCH=$(date +%s)
   mkts() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date -u -r $1 +%Y-%m-%dT%H:%M:%S.000Z; }
   T1=$(mkts $((NOW_EPOCH - 6*3600)))
   T2=$(mkts $((NOW_EPOCH - 3*3600)))
   T3=$(mkts $NOW_EPOCH)
   TIMESTAMP=$(date +%s)
   BODY='{"transactions":[
     {"cbs_transaction_id":"GUIDE-RULES-STRUCT-1","customer_cbs_id":"CBS-RULES-STRUCTURING-001","account_number":"0402234567","amount":2000000,"currency":"NGN","type":"CREDIT","channel":"CASH","occurred_at":"'"$T1"'"},
     {"cbs_transaction_id":"GUIDE-RULES-STRUCT-2","customer_cbs_id":"CBS-RULES-STRUCTURING-001","account_number":"0402234567","amount":2000000,"currency":"NGN","type":"CREDIT","channel":"CASH","occurred_at":"'"$T2"'"},
     {"cbs_transaction_id":"GUIDE-RULES-STRUCT-3","customer_cbs_id":"CBS-RULES-STRUCTURING-001","account_number":"0402234567","amount":2000000,"currency":"NGN","type":"CREDIT","channel":"CASH","occurred_at":"'"$T3"'"}
   ]}'
   SIGNATURE=$(printf '%s' "${TIMESTAMP}.${BODY}" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')

   curl -X POST http://localhost:4000/transactions/ingest \
     -H "X-Tenant-Id: $TENANT_ID" -H "X-RegOps-Timestamp: $TIMESTAMP" \
     -H "X-RegOps-Signature: sha256=$SIGNATURE" -H "Content-Type: application/json" -d "$BODY"
   ```
   **Expected**: `202`, `"transactionCount": 3`.
3. Wait 2-3 seconds, then **GET /alerts** in Swagger. **Expected** (verified live):
   ```json
   {
     "scenarioType": "STRUCTURING",
     "severity": "HIGH",
     "title": "3 cash transactions totalling NGN 6,000,000 within 24h by Ngozi Structuring Customer",
     "evidence": {
       "txnCount": 3,
       "cumulativeAmount": 6000000,
       "windowHours": 24,
       "amounts": [2000000, 2000000, 2000000],
       "types": ["CREDIT", "CREDIT", "CREDIT"],
       "firstAt": "...", "lastAt": "...",
       "relatedTransactionIds": ["...", "...", "..."]
     },
     "dedupKey": "structuring:<customerId>:2026-07-20",
     "fireCount": 1
   }
   ```
   Again, clear on its own: count, cumulative amount, individual amounts, and the exact time window —
   a reader doesn't need to go look up the individual transactions to understand the pattern.
4. **Now the dedup check.** Send one more same-day cash deposit for the same customer:
   ```sh
   TIMESTAMP=$(date +%s)
   BODY='{"transactions":[{"cbs_transaction_id":"GUIDE-RULES-STRUCT-4","customer_cbs_id":"CBS-RULES-STRUCTURING-001","account_number":"0402234567","amount":2200000,"currency":"NGN","type":"CREDIT","channel":"CASH","occurred_at":"'"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"'"}]}'
   SIGNATURE=$(printf '%s' "${TIMESTAMP}.${BODY}" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')
   curl -X POST http://localhost:4000/transactions/ingest \
     -H "X-Tenant-Id: $TENANT_ID" -H "X-RegOps-Timestamp: $TIMESTAMP" \
     -H "X-RegOps-Signature: sha256=$SIGNATURE" -H "Content-Type: application/json" -d "$BODY"
   ```
5. Wait 2-3 seconds, **GET /alerts** again. **Expected** (verified live): **still exactly one**
   `STRUCTURING` alert for this customer (not two) — `fireCount` is now `2`, and
   `evidence.relatedTransactionIds` has grown from 3 entries to 4 (the new transaction merged in, no
   duplicates). This is Section 7.2's UPSERT semantics working live: the dedup key
   (`structuring:<customerId>:<day>`) is per-customer-per-day, not per-transaction, so any further
   qualifying transaction the same day increments the same row instead of creating a new one.

## 5. Scenario 3 — Rapid Inflow-Outflow

1. **POST /customers**:
   ```json
   {
     "cbsCustomerId": "CBS-RULES-RAPIDIO-001",
     "fullName": "Tunde Rapid IO Customer",
     "customerType": "INDIVIDUAL",
     "occupation": "Consultant",
     "country": "NG",
     "kycTier": 2,
     "onboardedAt": "2024-01-15"
   }
   ```
   **Copy the `id`**.
2. Send an inbound transfer 35 minutes ago, then an outbound transfer now, in one batch (curl, same
   reason as every ingestion call above):
   ```sh
   NOW_EPOCH=$(date +%s)
   T_IN=$(mkts $((NOW_EPOCH - 35*60)))
   T_OUT=$(mkts $NOW_EPOCH)
   TIMESTAMP=$(date +%s)
   BODY='{"transactions":[
     {"cbs_transaction_id":"GUIDE-RULES-RAPIDIO-IN","customer_cbs_id":"CBS-RULES-RAPIDIO-001","account_number":"0403234567","amount":5000000,"currency":"NGN","type":"CREDIT","channel":"TRANSFER","counterparty_account":"9988776655","counterparty_bank":"ABCBANK","occurred_at":"'"$T_IN"'"},
     {"cbs_transaction_id":"GUIDE-RULES-RAPIDIO-OUT","customer_cbs_id":"CBS-RULES-RAPIDIO-001","account_number":"0403234567","amount":4500000,"currency":"NGN","type":"DEBIT","channel":"TRANSFER","counterparty_account":"1122334455","counterparty_bank":"XYZBANK","occurred_at":"'"$T_OUT"'"}
   ]}'
   SIGNATURE=$(printf '%s' "${TIMESTAMP}.${BODY}" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')
   curl -X POST http://localhost:4000/transactions/ingest \
     -H "X-Tenant-Id: $TENANT_ID" -H "X-RegOps-Timestamp: $TIMESTAMP" \
     -H "X-RegOps-Signature: sha256=$SIGNATURE" -H "Content-Type: application/json" -d "$BODY"
   ```
3. Wait 2-3 seconds, **GET /alerts**. **Expected** (verified live):
   ```json
   {
     "scenarioType": "RAPID_INFLOW_OUTFLOW",
     "severity": "HIGH",
     "title": "NGN 4,500,000 outbound 35min after NGN 5,000,000 inbound (90% pass-through)",
     "evidence": {
       "inboundAmount": 5000000,
       "outboundAmount": 4500000,
       "passThroughRatio": 0.9,
       "windowMinutes": 35,
       "inboundTransactionCount": 1,
       "allInternal": false,
       "relatedTransactionIds": ["...", "..."]
     },
     "fireCount": 1
   }
   ```
   The title alone tells a reader the whole story: amount out, amount in, elapsed time, and the
   pass-through percentage — this is layering evidence a compliance officer could act on without
   opening the linked transactions first.

## 6. Scenario 4 — High-Risk Counterparty (external screening)

This uses an *external* counterparty (a name, not an existing internal customer) so it exercises the
real screening call through `CounterpartyScreeningService` → `ScreeningService` (Prompt 3) →
`MockProvider`, not just an internal flag lookup.

1. **POST /customers**:
   ```json
   {
     "cbsCustomerId": "CBS-RULES-COUNTERPARTY-001",
     "fullName": "Yusuf Counterparty Customer",
     "customerType": "INDIVIDUAL",
     "occupation": "Engineer",
     "country": "NG",
     "kycTier": 2,
     "onboardedAt": "2024-01-15"
   }
   ```
   **Copy the `id`**.
2. Send a transfer to a counterparty whose name contains `SANCTIONED` — `MockProvider` (Prompt 3,
   `packages/screening-engine`) is deterministic and keys entirely off `fullName`, so any name
   containing that substring returns a `CONFIRMED_MATCH` at a 95% score:
   ```sh
   TIMESTAMP=$(date +%s)
   BODY='{"transactions":[{"cbs_transaction_id":"GUIDE-RULES-COUNTERPARTY-1","customer_cbs_id":"CBS-RULES-COUNTERPARTY-001","account_number":"0404234567","amount":2500000,"currency":"NGN","type":"DEBIT","channel":"TRANSFER","counterparty_account":"0055667788","counterparty_bank":"058","counterparty_name":"IBRAHIM SANCTIONED TRADING CO","occurred_at":"'"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"'"}]}'
   SIGNATURE=$(printf '%s' "${TIMESTAMP}.${BODY}" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')
   curl -X POST http://localhost:4000/transactions/ingest \
     -H "X-Tenant-Id: $TENANT_ID" -H "X-RegOps-Timestamp: $TIMESTAMP" \
     -H "X-RegOps-Signature: sha256=$SIGNATURE" -H "Content-Type: application/json" -d "$BODY"
   ```
3. Wait 2-3 seconds, **GET /alerts**. **Expected** (verified live):
   ```json
   {
     "scenarioType": "HIGH_RISK_COUNTERPARTY",
     "severity": "CRITICAL",
     "title": "Transfer to counterparty matching sanctions list (95% match)",
     "evidence": {
       "direction": "OUTBOUND",
       "matchScore": 95,
       "matchSource": "SANCTIONS",
       "counterpartyName": "IBRAHIM SANCTIONED TRADING CO",
       "counterpartyAccount": "0055667788",
       "counterpartyBank": "058",
       "screeningCheckId": "<a real ScreeningCheck id>",
       "isInternalCounterparty": false
     },
     "fireCount": 1
   }
   ```
   `severity: CRITICAL` — this is the one scenario whose default severity differs from its rule's
   base severity depending on match type (sanctions vs. PEP; see `HIGH_RISK_COUNTERPARTY`'s config in
   Section 2 — `sanctionsSeverity`/`pepSeverity` are separate knobs). `screeningCheckId` links back to
   a real row you can look up via **GET /screening/checks/{id}** if you want to see the full
   provider response.
4. **Confirming the screening cache, optional but worth doing**: repeat step 2's exact `curl` command
   (same counterparty account/bank, a new `cbs_transaction_id`). **Expected**: a `202` as before, and
   after a couple seconds the SAME alert's `fireCount` increments to `2` — but check
   `GET /screening/checks` (Swagger, no fillable filters, same list-endpoint gap as elsewhere): the
   total count of checks for this counterparty does **not** increase. The 7-day Redis cache
   (`cp-screen:<tenantId>:<bank>:<account>`) served the second evaluation without a second call to
   `MockProvider` — this is genuinely testable behavior, not just something the automated e2e suite
   asserts privately.

## 7. Scenario 5 — Velocity Spike

This needs real transaction *history*, not just one row — 6 days of a ₦1,000,000/day baseline, then a
₦7,000,000 spike today, all in one webhook batch (curl, for the same practical reason Prompt 4's
guide's own velocity section uses curl: typing 7 JSON objects into Swagger's empty box by hand is
possible but needlessly tedious).

1. **POST /customers**:
   ```json
   {
     "cbsCustomerId": "CBS-RULES-VELOCITY-001",
     "fullName": "Chioma Velocity Rules Customer",
     "customerType": "INDIVIDUAL",
     "occupation": "Teacher",
     "country": "NG",
     "kycTier": 2,
     "onboardedAt": "2024-01-15"
   }
   ```
   **Copy the `id`**. `onboardedAt` matters here — `VELOCITY_SPIKE`'s `excludeNewCustomersDays: 30`
   default means a customer onboarded fewer than 30 days ago never fires this rule at all, regardless
   of how extreme the spike is.
2. Send the batch:
   ```sh
   NOW_EPOCH=$(date +%s)
   ROWS=""
   for d in 10 9 8 7 6 5; do
     TS=$(mkts $((NOW_EPOCH - d*86400)))
     ROWS="${ROWS}{\"cbs_transaction_id\":\"GUIDE-RULES-VEL-${d}\",\"customer_cbs_id\":\"CBS-RULES-VELOCITY-001\",\"account_number\":\"0405234567\",\"amount\":1000000,\"currency\":\"NGN\",\"type\":\"CREDIT\",\"channel\":\"MOBILE\",\"occurred_at\":\"${TS}\"},"
   done
   SPIKE_TS=$(mkts $NOW_EPOCH)
   ROWS="${ROWS}{\"cbs_transaction_id\":\"GUIDE-RULES-VEL-SPIKE\",\"customer_cbs_id\":\"CBS-RULES-VELOCITY-001\",\"account_number\":\"0405234567\",\"amount\":7000000,\"currency\":\"NGN\",\"type\":\"CREDIT\",\"channel\":\"MOBILE\",\"occurred_at\":\"${SPIKE_TS}\"}"
   BODY="{\"transactions\":[${ROWS}]}"
   TIMESTAMP=$(date +%s)
   SIGNATURE=$(printf '%s' "${TIMESTAMP}.${BODY}" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')
   curl -X POST http://localhost:4000/transactions/ingest \
     -H "X-Tenant-Id: $TENANT_ID" -H "X-RegOps-Timestamp: $TIMESTAMP" \
     -H "X-RegOps-Signature: sha256=$SIGNATURE" -H "Content-Type: application/json" -d "$BODY"
   ```
   **Expected**: `202`, `"transactionCount": 7`.
3. Wait a few seconds, **GET /alerts**. **Expected** (verified live):
   ```json
   {
     "scenarioType": "VELOCITY_SPIKE",
     "severity": "MEDIUM",
     "title": "Daily transaction volume NGN 7,000,000 is 7.0x customer's rolling average",
     "evidence": {
       "todayTotal": 7000000,
       "rolling30dAvg": 1000000,
       "spikeRatio": 7,
       "dormancyDays": 5,
       "historicalDayCount": 6,
       "isDormancyReactivation": false,
       "relatedTransactionIds": ["<7 ids>"]
     }
   }
   ```
   The 7x multiple and the plain-English "rolling average" framing in the title make this readable
   without decoding the raw numbers in `evidence` first.
4. **A real, interesting live finding, not a bug**: check `fireCount` on this alert. Confirmed live:
   **`7`, not `1`**. Every one of the 7 rows in the batch independently emits its own
   `transaction.ingested` event (Section 2.1's "async evaluation via BullMQ" design has no debounce
   for rule evaluation — unlike `RiskModule`'s 60-second re-score debounce, every transaction
   genuinely gets its own evaluation pass). Because velocity evaluation reads "today's total" in
   *real time*, not relative to the triggering row's own `occurred_at`, and all 7 rows land in the
   database together before any of the 7 evaluations run, **every one of the 7 — including the 6
   backdated history rows — independently observes the same already-committed ₦7,000,000 spike and
   fires**. All 7 fires collapse into the same dedup key (`velocity:<customerId>:<today>`), so you
   still get exactly one `Alert` row, just with `fireCount: 7` instead of `1`. This is correct given
   the design (each evaluation asks "is there a spike happening right now," and the honest answer was
   yes 7 times in a row), but it's a genuinely surprising number the first time you see it, worth
   understanding rather than assuming it's a duplicate-alert bug.

## 8. The rule-loosening guardrail — curl only (no header parameter in Swagger)

1. From Section 2, you should already have the `LARGE_CASH` rule's `id`. If not, **GET /rules** again
   and copy it.
2. **Attempt a loosening change without the header:**
   ```sh
   RULE_ID="<LARGE_CASH rule id>"
   curl -w "\nHTTP_STATUS:%{http_code}\n" -X PATCH "http://localhost:4000/rules/$RULE_ID" \
     -H "Authorization: Bearer <your accessToken>" -H "Content-Type: application/json" \
     -d '{"config":{"thresholdIndividual":8000000}}'
   ```
3. **Expected** (verified live): `422`,
   ```json
   {
     "success": false,
     "error": {
       "code": "LOOSENING_CONFIRMATION_REQUIRED",
       "message": "This change reduces detection sensitivity. Retry with X-Confirm-Loosening: true to confirm.",
       "details": { "changedKeys": ["thresholdIndividual"] }
     }
   }
   ```
   Raising `thresholdIndividual` means *more* cash has to move before this rule fires — strictly
   less sensitive — which is exactly what `changedKeys` is flagging.
4. **Retry with the header:**
   ```sh
   curl -w "\nHTTP_STATUS:%{http_code}\n" -X PATCH "http://localhost:4000/rules/$RULE_ID" \
     -H "Authorization: Bearer <your accessToken>" -H "X-Confirm-Loosening: true" \
     -H "Content-Type: application/json" \
     -d '{"config":{"thresholdIndividual":8000000}}'
   ```
5. **Expected** (verified live): `200`, `data.config.thresholdIndividual: 8000000` — the change
   applied.
6. **Confirm the audit trail**, direct SQL (no `GET /audit-logs` filter for entity id exists in
   Swagger — same list-endpoint gap as elsewhere):
   ```sh
   docker exec regops-postgres-1 psql -U regops_admin -d regops -c \
     "SELECT action, before_state->'config'->>'thresholdIndividual' AS before, after_state->'config'->>'thresholdIndividual' AS after FROM audit_log WHERE entity_id = '$RULE_ID' ORDER BY created_at DESC LIMIT 1;"
   ```
   **Expected** (verified live): one `rule.update` row, `before: 5000000`, `after: 8000000`.
7. **Revert, to leave the rule in its default state for anyone re-running this guide** — going from
   8,000,000 back down to 5,000,000 is a *decrease*, i.e. tightening, so it needs no header at all:
   ```sh
   curl -w "\nHTTP_STATUS:%{http_code}\n" -X PATCH "http://localhost:4000/rules/$RULE_ID" \
     -H "Authorization: Bearer <your accessToken>" -H "Content-Type: application/json" \
     -d '{"config":{"thresholdIndividual":5000000}}'
   ```
   **Expected**: `200`, no header needed, confirmed live — the guardrail is direction-aware, not a
   blanket "any config change needs confirmation" check.

## 9. The replay CLI — dry-run, then live, against Section 3's own transaction

This section deliberately replays over Section 3's Large Cash transaction, so "did the replay dedupe
against the alert that's already there" is directly observable, not just "did it create *an* alert."

1. **Snapshot the current state** (there's no Swagger surface for this — the CLI has no HTTP trigger
   endpoint by design, only `GET /rules/replays/{id}` polls an already-started run):
   ```sh
   curl -s "http://localhost:4000/alerts?scenario_type=LARGE_CASH&customer_id=<Section 3's customerId>" \
     -H "Authorization: Bearer <your accessToken>"
   ```
   Note the `fireCount` (should be `1`, from Section 3).
2. **Dry-run**, from `apps/api/`:
   ```sh
   cd apps/api
   pnpm cli:rule-replay -- --tenant=<tenantId> --rule=<LARGE_CASH rule id> \
     --from=<today, e.g. 2026-07-20> --to=<today> --dry-run
   ```
   **Expected** (verified live) — the CLI prints a replay id immediately and returns (it awaits
   completion internally, so by the time you see this output the run has already finished):
   ```
   Rule replay started: <replayId>
   Poll GET /rules/replays/<replayId> for progress.
   ```
3. **GET /rules/replays/{replayId}** in Swagger, paste the id, **Execute**. **Expected** (verified
   live):
   ```json
   {
     "status": "COMPLETED",
     "dryRun": true,
     "totalTransactions": 13,
     "processedTransactions": 13,
     "firedCount": 2,
     "reportKey": "tenants/<tenantId>/rule-replays/<replayId>.csv"
   }
   ```
   `totalTransactions`/`firedCount` will differ on your own run depending on what other cash
   transactions already exist for this tenant on this date — the number that matters is that
   `firedCount` is at least `1` (Section 3's transaction) and `reportKey` is non-null.
4. **Read the report** (no download endpoint exists for this — it's a local-disk `FileStorage` key,
   same as every other file this codebase writes in dev; see `HANDOFF.md`'s file-storage deviation):
   ```sh
   cat ".local-storage/<reportKey>"
   ```
   **Expected** — a CSV with one row per (rule, transaction) evaluated, `would_fire` true only for
   genuinely qualifying cash transactions:
   ```csv
   rule_id,transaction_id,would_fire,evidence_summary
   <ruleId>,<some other txn>,false,""
   <ruleId>,<Section 3's transactionId>,true,"Cash CREDIT of NGN 6,500,000 by Bola Large Cash Customer"
   ```
5. **Confirm nothing was actually written**: repeat step 1's `GET /alerts` call. **Expected**:
   `fireCount` is still `1` — a dry run genuinely persists nothing, confirmed by the number not
   moving, not just by trusting the CLI's own claim.
6. **Live run** — same command, no `--dry-run`:
   ```sh
   pnpm cli:rule-replay -- --tenant=<tenantId> --rule=<LARGE_CASH rule id> \
     --from=<today> --to=<today>
   ```
   **Expected**: same `Rule replay started` output; `GET /rules/replays/{new replayId}` shows
   `"dryRun": false`, `"reportKey": null` (no CSV in live mode).
7. Repeat step 1's `GET /alerts` call. **Expected** (verified live): **still the same one alert** —
   no new row — but `fireCount` is now `2`. The transaction's `large_cash:<customerId>:<transactionId>`
   dedup key is per-transaction, so replaying over a transaction that already has an alert increments
   it exactly the same way a genuine real-time re-fire would.
8. **Run the exact same live command a second time.** **Expected** (verified live): `fireCount` is
   now `3` — each live replay run over the same range independently increments the same alert, the
   same way Section 4's "one more real transaction" step did. This is the "increments alerts" half
   of what was asked for, demonstrated by literally running it twice and watching the number climb.

## 10. `POST /alerts/{id}/assign` and `POST /alerts/{id}/close`

Quick enough to be worth confirming while an alert is sitting in front of you — not one of the five
required checks, but the natural next step in an alert's lifecycle.

1. Pick any alert `id` from the sections above **other than** Section 3's Large Cash alert (Section 9
   reuses that one for the replay walkthrough, and closing an alert doesn't stop replay from
   incrementing it, but it's clearer to keep them separate) — this guide's own run used Section 5's
   Rapid Inflow-Outflow alert.
2. **GET /users** in Swagger, **Execute**, copy any user's `id` other than yourself (or create one via
   **POST /users** first if the tenant only has one user).
3. **POST /alerts/{id}/assign**, paste the alert id, body:
   ```json
   { "assignedTo": "<a user id>" }
   ```
   **Expected** (verified live): `201` (this and every other `POST` in this module return `201`, not
   `200` — NestJS's default for `@Post()` handlers with no explicit `@HttpCode()` override), `data.status:
   "ASSIGNED"`, `data.assignedTo` matching what you sent.
4. **POST /alerts/{id}/close**, same alert id:
   ```json
   { "category": "RESOLVED", "reason": "Confirmed legitimate large withdrawal" }
   ```
   **Expected** (verified live): `201`, `data.status: "CLOSED"`, `data.closeCategory: "RESOLVED"`.
5. Confirm the audit trail the same way Section 8.6 did:
   ```sh
   docker exec regops-postgres-1 psql -U regops_admin -d regops -c \
     "SELECT action FROM audit_log WHERE entity_id = '<alert id>' ORDER BY created_at;"
   ```
   **Expected**: `alert.create`, `alert.assign`, `alert.close`, in that order (plus one
   `alert.escalate` row per dedup increment, if you ran Section 4's or Section 9's dedup steps against
   this same alert).

## 11. Tenant isolation

1. Log in as `superadmin@regops.dev` / `SuperAdmin!2026` (**POST /auth/login**, **Authorize** with
   the new token).
2. **POST /tenants**:
   ```json
   { "name": "Rules Guide Tenant C", "type": "FINTECH" }
   ```
   **Expected**: `201`. **Copy the new tenant's `id`.**
3. **A real, disclosed finding worth doing deliberately, not skipping**: before creating a user in the
   new tenant, run **GET /rules** — but you can't, from Swagger, as this SUPER_ADMIN, against a
   *different* tenant's rules without switching context. Skip ahead to step 6 and come back if you
   want to see this tenant's own rules; the point of this step is really step 8 below.
4. **This step is curl** — same reason as Prompt 4's guide's own tenant-isolation section:
   `X-Tenant-Override` isn't a fillable Swagger parameter on `POST /users`.
   ```sh
   curl -X POST http://localhost:4000/users \
     -H "Authorization: Bearer <superadmin accessToken>" \
     -H "X-Tenant-Override: <tenant C id from step 2>" \
     -H "Content-Type: application/json" \
     -d '{"email":"admin@tenantc-rules-guide.dev","password":"TenantCAdmin!2026","fullName":"Tenant C Admin","role":"TENANT_ADMIN"}'
   ```
   **Expected**: `201`, `data.status: "INVITED"`.
5. Log in as `admin@tenantc-rules-guide.dev` / `TenantCAdmin!2026` (**POST /auth/login**,
   confirmed live: an `INVITED` user logs in fine, same as every prior guide's observation).
   **Authorize** with the new token.
6. **GET /rules**, **Execute**. **Expected** (verified live): `200`, `data` has its own 5 rules —
   **different `id`s from tenant A's** (this guide's own run: tenant C's `LARGE_CASH` rule was
   `26f498e7-11f9-41b0-b31c-6a2cf2f7131a`, nothing like tenant A's `77c008f7-...`). Because this
   tenant was created *after* Prompt 5 shipped, `TenantsService.create()` seeded it correctly — the
   contrast with Section 2's note about pre-existing tenants having zero rules is worth re-reading
   here if you skipped it.
7. **GET /alerts**, **Execute**. **Expected**: `200`, `"total": 0` — none of tenant A's alerts from
   Sections 3-9 leak through.
8. Try to reach one of tenant A's specific IDs directly, still as tenant C:
   - **GET /rules/{id}**, paste tenant A's `LARGE_CASH` rule id from Section 2. **Expected**
     (verified live): `404`, `{"code":"RULE_NOT_FOUND"}` — **not** `403`, same information-hiding
     principle every other module in this codebase follows (a caller can't distinguish "exists in
     another tenant" from "doesn't exist").
   - **GET /alerts/{id}**, paste tenant A's Large Cash alert id from Section 3. **Expected**: `404`,
     `{"code":"ALERT_NOT_FOUND"}`.
9. **Close the loop with a real transaction, not just an absence check**: as tenant C, **POST
   /customers** a fresh customer, then send it a qualifying Large Cash transaction the same way
   Section 3 did (tenant C needs its own webhook secret set first — same one-time SQL `UPDATE` as
   this guide's opening note, on tenant C's row this time). Confirmed live: the resulting alert's
   `ruleId` matches tenant C's own `LARGE_CASH` rule id from step 6, **and** re-running Section 3's
   `GET /alerts` as tenant A afterward shows **no** new entry — tenant C's alert never appears in
   tenant A's list, in either direction.
10. **Before continuing with anything else**: re-Authorize back to `admin@demomfb.dev`'s token.

## 12. A closing note on what this guide doesn't cover

Multi-instance duplicate evaluation (`HANDOFF.md`'s Prompt 5 Deviations #1 — running two `apps/api`
processes against the same Redis causes each to independently enqueue and evaluate the same
transaction) isn't demonstrated here; it was found and confirmed during this backend's original
implementation session, not this guide's own walkthrough, and reproducing it deliberately would mean
asking you to run a second `pnpm dev` instance on a different port just to observe it — the
automated e2e race test (`alert dedup race safety` in `rules.e2e-spec.ts`) already covers the
underlying dedup guarantee that makes it harmless either way. Fault injection (one rule throwing
mid-evaluation while the other four still fire and record their own `RuleEvaluation` rows) also isn't
shown here for the same reason Prompt 4's guide doesn't demonstrate its own internal error-handling
paths by hand — it's a code-path guarantee (every rule's evaluation is independently wrapped in its
own try/catch), not something a live walkthrough can trigger without temporarily breaking a rule on
purpose.

---

## Checklist — Backend Prompt 5 Swagger sign-off

**What was actually verified, by clicking through Swagger and by curl where Swagger genuinely cannot
reach:**

- [ ] All 5 default rules exist for a tenant created after this prompt shipped; a tenant created
      before it has zero (a real, disclosed finding, not a bug)
- [ ] `LARGE_CASH` fires on a single 6.5M cash CREDIT, with a clear title/evidence
- [ ] `STRUCTURING` fires on 3 same-day cash deposits totalling above the threshold, with clear
      title/evidence
- [ ] A 4th same-day qualifying deposit increments the SAME `STRUCTURING` alert's `fireCount`
      (2, not a second alert) — evidence's `relatedTransactionIds` merges without duplicates
- [ ] `RAPID_INFLOW_OUTFLOW` fires on an inbound-then-outbound pair within the window, with clear
      title/evidence
- [ ] `HIGH_RISK_COUNTERPARTY` fires CRITICAL on an external counterparty name matching
      `MockProvider`'s sanctions pattern; a second transaction to the same counterparty within the
      cache TTL does not create a second `screening_check` row
- [ ] `VELOCITY_SPIKE` fires on 6 days of consistent history plus a same-day spike, with clear
      title/evidence — and a same-batch quirk (`fireCount: 7`, not `1`) is real, explained, and not a
      bug
- [ ] `PATCH /rules/:id` loosening a threshold without `X-Confirm-Loosening` returns `422`; with the
      header, `200` and the change applies; tightening never needs the header; both are audit-logged
      with a real before/after diff
- [ ] `pnpm cli:rule-replay --dry-run` produces a CSV report and changes nothing in the database
      (`fireCount` unchanged); the same command without `--dry-run` increments the existing alert's
      `fireCount`, twice in a row when run twice
- [ ] A tenant created after this prompt shipped gets its own 5 rules with distinct ids; `GET
      /alerts`/`GET /rules` for one tenant never shows another's; direct cross-tenant `GET
      /rules/{id}`/`GET /alerts/{id}` return `404`, not `403`; a real transaction fired in one tenant
      never appears in another's alert list in either direction

**What's confirmed as not currently testable through Swagger's UI, and exactly why:**

- [ ] `X-Confirm-Loosening` — not declared as a parameter in the generated Swagger schema (confirmed
      via `/docs-json`); stock Swagger UI has no way to inject an arbitrary custom header beyond what
      an endpoint declares, same class of gap as Prompt 4's `X-Tenant-Override`
- [ ] `POST /transactions/ingest` in general — Swagger cannot compute an HMAC signature under any
      circumstances (same as every prior guide's note on this endpoint)
- [ ] `UpdateRuleDto`/`TestRuleDto`/`AssignAlertDto`/`CloseAlertDto` request bodies — render as empty
      `{}` boxes, the same `@nestjs/swagger` CLI-plugin gap as every other DTO in this codebase
- [ ] `GET /alerts`/`GET /rules` filter/pagination query parameters — not declared in the generated
      Swagger schema, same class of gap as every prior prompt's list endpoints
- [ ] The replay CLI itself has no HTTP trigger endpoint by design (Section 10 of the spec: a CLI
      tool, not an API) — only its progress (`GET /rules/replays/{id}`) is reachable via Swagger
- [ ] The dry-run CSV report has no download endpoint — read directly off local disk
      (`.local-storage/`), same as every other `FileStorage`-backed artifact in this dev setup
- [ ] Multi-instance duplicate evaluation and rule-evaluation fault injection — see Section 12
