# Swagger Test Guide — Backend Prompt 3.5 (Customer Module Enhancements)

A pure click-by-click walkthrough of the Prompt 3.5 endpoints, done entirely inside the Swagger API
explorer at `http://localhost:4000/docs`. No curl, no terminal commands, and no reference to the
real web app at `localhost:3000`.

**Before you start**: `docker-compose up -d` and `pnpm dev` need to already be running.

**Account used throughout**: `admin@demomfb.dev` / `TenantAdmin!2026` (TENANT_ADMIN, tenant "Demo
MFB Limited"). TENANT_ADMIN is included in every endpoint's allowed-role list in this guide.

This guide is honest about a few real, verified rough edges, same as every prior prompt's guide.
Three are Swagger documentation gaps (the underlying endpoints work correctly, they're just not
fully wired up as clickable/typed fields yet): `GET /customers/export` has no query-parameter
fields, `POST /customers/:id/photo` has no file-picker field, and `CreateCustomerDto` (including
its new `isPep`/`pepDetails` fields) renders as an empty `{}` box. All of these were confirmed by
actually clicking through (or, for the write-up in `HANDOFF.md`, by curling the live server) rather
than assumed.

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
   `{"mfaRequired": true, "mfaToken": "..."}`**, follow **POST /auth/verify-mfa** the same way prior
   guides describe, then use the `accessToken` from that response instead.
5. Click the **Authorize** button (top of the page), paste the token, and click **Authorize** again.
   Every request below now includes it automatically.

## 2. `POST /customers` — creating a PEP customer without `pepDetails` (a real 400)

1. In the **customers** section, click **POST /customers**, then **Try it out**.
2. Paste (note there is no `pepDetails` field here — the whole point of this step):
   ```json
   {
     "cbsCustomerId": "CBS-PEP-001",
     "fullName": "Missing Details Subject",
     "customerType": "PEP",
     "kycTier": 2,
     "onboardedAt": "2024-01-15"
   }
   ```
3. Click **Execute**.
4. **Expected**: `400`, `error.code: "PEP_DETAILS_REQUIRED"`. Confirmed live — this is a real,
   deliberate guard: `customerType: "PEP"` always requires a nested `pepDetails` object.
5. **A real Swagger gap**: `CreateCustomerDto`'s request body renders as an empty `{}` box with no
   labeled fields (pre-existing, not introduced by this prompt — every property on this DTO has
   always rendered this way; the new `isPep`/`pepDetails` fields simply inherit it). The JSON above,
   and in every subsequent step, has to be typed in by hand.

## 3. `POST /customers` — a real PEP customer, landing in `PENDING_EDD_APPROVAL`

1. Still on **POST /customers**, **Try it out**, and paste:
   ```json
   {
     "cbsCustomerId": "CBS-PEP-002",
     "fullName": "Ibrahim Balogun",
     "customerType": "PEP",
     "kycTier": 2,
     "onboardedAt": "2024-01-15",
     "pepDetails": {
       "pepCategory": "DOMESTIC",
       "pepPosition": "Senator",
       "pepInstitution": "National Assembly",
       "pepCountry": "NG",
       "pepStatus": "CURRENT",
       "pepStartDate": "2020-01-01",
       "sourceOfWealth": "Legislative salary and prior business interests.",
       "nextReviewDate": "2027-01-01"
     }
   }
   ```
2. Click **Execute**.
3. **Expected**: `201`. `data.status` is `"PENDING_EDD_APPROVAL"`, `data.isPep` is `true`,
   `data.riskScore` is `100` and `data.riskLevel` is `"CRITICAL"` — confirmed live: the PEP
   risk-score override applies to this customer's very first score, not a later re-score. **Copy
   the `id` value** — you'll reuse it for the rest of this guide.
4. **Failure mode**: `data.status` coming back `"ACTIVE"` here would be a real regression — a PEP
   customer must never be immediately fully onboarded.

## 4. `GET /customers` — confirm it's visible, filterable by the new status

1. Click **GET /customers**, **Try it out**, type `PENDING_EDD_APPROVAL` into **status**, click
   **Execute**.
2. **Expected**: `200`, and the customer from step 3 appears in `data.data`. No code change was
   needed to make this work — `status` was already a filterable field before this prompt; the new
   enum value just slots in.

## 5. `PATCH /customers/{id}` — confirming the approval gate can't be bypassed

1. Click **PATCH /customers/{id}**, **Try it out**, paste the `id` from step 3, and paste:
   ```json
   { "status": "ACTIVE" }
   ```
2. Click **Execute**.
3. **Expected**: `409`, `error.code: "PEP_APPROVAL_REQUIRED"`. This is a deliberate guard added
   alongside the approval feature itself (see `HANDOFF.md`'s deviations) — without it, a plain PATCH
   could silently bypass the senior-approval requirement and its audit trail.
4. **A related check, not required for this guide to continue**: PATCHing `{ "status":
   "PENDING_EDD_APPROVAL" }` onto a normal `ACTIVE` customer returns `400
   STATUS_NOT_DIRECTLY_SETTABLE` — that status is system-managed, only reachable via step 3's create
   path.

## 6. `POST /customers/{id}/approve-pep` — the real approval

1. Click **POST /customers/{id}/approve-pep**, **Try it out**, paste the same `id`, click
   **Execute**. (No request body needed.)
2. **Expected**: `201`. `data.status` is now `"ACTIVE"`.
3. **Failure mode**: repeating this exact request now returns `409
   CUSTOMER_NOT_PENDING_EDD_APPROVAL` — decisions are final, same "no re-running an already-settled
   workflow step" principle as screening's match review.

## 7. `POST /customers/{id}/photo` — uploading a profile photo

1. Click **POST /customers/{id}/photo**, **Try it out**.
2. **A real Swagger gap**: no file-picker field renders here at all — no `requestBody` is declared
   for this operation in the generated OpenAPI document (confirmed by inspecting the live
   `/docs-json`), same root cause as `POST /customers/batch`'s missing CSV file-picker in Prompt 2's
   guide (the `@nestjs/swagger` CLI plugin isn't enabled). **This means this specific step cannot
   actually be completed through Swagger's UI** — there is no field to attach a file to. It was
   verified instead via direct `curl` (see `HANDOFF.md`): uploading a small JPEG returns `201` with
   `data.photoUrl` set to a storage key (not a browsable URL — see step 8's note), and a
   `customer.photo.upload` audit row is written.
3. If you want to see the real behavior anyway: use `curl -X POST
   http://localhost:4000/customers/{id}/photo -H "Authorization: Bearer <token>" -F
   "file=@photo.jpg;type=image/jpeg"` from a terminal instead — this is the one step in this guide
   that isn't Swagger-only, disclosed rather than silently worked around.

## 8. `GET /customers/{id}/photo` — downloading it back

1. Click **GET /customers/{id}/photo**, **Try it out**, paste the `id`, click **Execute**.
2. **Expected**: `200`, with `Content-Type: image/jpeg` (or whatever format you uploaded) —
   Swagger's UI shows a **Download file** link for binary responses rather than rendering JSON.
   Downloading and opening it should show the exact bytes you uploaded in step 7.
3. **Note on `photoUrl`**: the value returned by `GET /customers/{id}` (e.g.
   `"tenants/{tenantId}/customers/{id}/photo.jpg"`) is a `FileStorage` key, not a URL you can paste
   into a browser directly — `LocalFileStorage.getSignedDownloadUrl()` always returns `null` in
   local dev (real cloud storage would return a real signed URL here instead). This endpoint is how
   you actually fetch the bytes regardless of which `FileStorage` implementation is active.

## 9. `DELETE /customers/{id}/photo` — removing it

1. Click **DELETE /customers/{id}/photo**, **Try it out**, paste the same `id`, click **Execute**.
2. **Expected**: `204`.
3. Repeat step 8 (**GET /customers/{id}/photo**) with the same `id`.
4. **Expected**: `404`, `error.code: "CUSTOMER_PHOTO_NOT_FOUND"`.
5. **A real, disclosed limitation, not a bug**: this clears the `photo_url` database reference, but
   doesn't (can't — the `FileStorage` interface has no `delete()` method, and extending it was out
   of this prompt's scope) remove the underlying stored file. See `HANDOFF.md`'s deviations.

## 10. `GET /customers/export` — CSV export

1. Click **GET /customers/export**, **Try it out**.
2. **A real Swagger gap**: no query-parameter fields are declared here either (confirmed via
   `/docs-json`: `parameters: []`) — same class of gap as `GET /customers`' own fuzzy-search
   parameter in Prompt 2's guide. Click **Execute** with no filters for now.
3. **Expected**: `200`, and Swagger's UI offers a **Download file** link (response `Content-Type:
   text/csv`, `Content-Disposition: attachment; filename="customers-export-<timestamp>.csv"`).
   Opening the downloaded file shows a header row (`id,cbsCustomerId,fullName,bvn,nin,email,phone,
   dateOfBirth,customerType,occupation,country,nationality,kycTier,riskScore,riskLevel,isPep,
   isSanctioned,status,onboardedAt`) followed by one row per customer — confirmed live against the
   demo tenant. `bvn`/`nin` are masked (e.g. `*******1234`), never plaintext — the same masking `GET
   /customers` already applies by default.
4. To confirm filtering works despite the missing Swagger fields: manually append a query string to
   the request URL in your browser's address bar instead, e.g.
   `http://localhost:4000/customers/export?customer_type=PEP`, with the `Authorization` header set
   via a tool like a REST client — or take this on faith from `HANDOFF.md`'s live-verified write-up,
   since Swagger's UI itself has no field to type a filter into for this step.

## 11. `GET /audit-logs` — confirm every new action type actually landed

1. In the **audit** section, click **GET /audit-logs**, **Try it out**, type `50` into **limit**,
   click **Execute**.
2. **Expected**: `200`. Among the entries, confirm you can find:
   - `customer.create` — from step 3, `afterState.status: "PENDING_EDD_APPROVAL"`
   - `customer.pep_approved` — from step 6, `afterState` showing `status: "ACTIVE"` and a real
     `eddApprovedBy` id
   - `customer.photo.upload` — from step 7 (if you completed it via curl)
   - `customer.photo.delete` — from step 9
3. **Failure mode**: any of these missing despite the corresponding step succeeding would be a real
   regression — every state change in this module is supposed to be audited, no exceptions.

---

## Checklist — Backend Prompt 3.5 Swagger sign-off

**What was actually verified by clicking through Swagger:**

- [ ] `customerType: "PEP"` without `pepDetails` returns `400 PEP_DETAILS_REQUIRED`
- [ ] `customerType: "PEP"` with `pepDetails` returns `201` with `status: "PENDING_EDD_APPROVAL"`,
      `isPep: true`, and a risk score/level already reflecting the PEP override
- [ ] `GET /customers?status=PENDING_EDD_APPROVAL` shows the pending customer
- [ ] `PATCH /customers/{id}` with `status: "ACTIVE"` on a pending customer returns `409
      PEP_APPROVAL_REQUIRED`
- [ ] `POST /customers/{id}/approve-pep` transitions to `ACTIVE`; repeating it returns `409
      CUSTOMER_NOT_PENDING_EDD_APPROVAL`
- [ ] `DELETE /customers/{id}/photo` then `GET /customers/{id}/photo` correctly 404s
      (`CUSTOMER_PHOTO_NOT_FOUND`)
- [ ] `GET /customers/export` downloads a real CSV with masked `bvn`/`nin`
- [ ] `GET /audit-logs` shows `customer.pep_approved` with the real approving user's id

**What's confirmed as not currently testable through Swagger, and exactly why:**

- [ ] `POST /customers/:id/photo`'s happy path — no file-picker field exists in Swagger for this
      operation at all (confirmed against the live `/docs-json`, not assumed); verified instead via
      direct `curl` and by the automated e2e suite (byte-for-byte round trip)
- [ ] `GET /customers/export`'s filter query params (`customer_type`, `status`, `q`, etc.) — not
      declared in the generated Swagger schema, same class of gap as `GET /customers`' own
      fuzzy-search param; filtering itself works, confirmed by `curl` and by the e2e suite
- [ ] `CreateCustomerDto`'s fields, including the new `isPep`/`pepDetails` — render as an empty `{}`
      box; this guide's JSON bodies have to be typed in by hand
- [ ] Removing the actual stored photo bytes on `DELETE /customers/:id/photo` — not possible through
      any interface this codebase exposes today (`FileStorage` has no `delete()` method); only the
      database reference is cleared, disclosed as a real limitation in `HANDOFF.md`, not silently
      assumed fixed
