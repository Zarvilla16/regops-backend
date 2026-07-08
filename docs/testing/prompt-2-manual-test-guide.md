# Manual Test Guide — Backend Prompt 2 (Customer + Risk Rating Module)

Like the Prompt 1 guide, this is entirely point-and-click — no terminal commands beyond the
one-time bootstrap. Read **Section A** first regardless: it's short, because this module's web
app pages haven't been built yet (that's a separate, later piece of work — "UI Prompt 2" — not
part of what's covered here). **Section B** is where all the real testing happens, driven entirely
through the Swagger explorer at `http://localhost:4000/docs`.

This guide is also honest about a few rough edges in Swagger's own documentation for this module
(not the underlying API itself — the endpoints work correctly, they're just not fully wired up as
clickable fields in Swagger yet). Where that's the case, it says so plainly rather than smuggling
in a workaround.

## Prerequisites

1. Everything from `prompt-1-manual-test-guide.md`'s prerequisites — Docker containers up, `.env`
   files in place, `pnpm install && pnpm build && pnpm db:migrate && pnpm db:seed && pnpm dev`
   running in one terminal you can then leave alone.
2. **The worker process must be running** — `pnpm dev` starts it alongside the api/web apps. If
   you only started the API on its own, restart with plain `pnpm dev`. (Nothing in this guide's
   Section A or B actually depends on the worker directly — CSV ingestion is the one Prompt 2
   feature that needs it, and as you'll see below, CSV ingestion isn't currently reachable through
   either browser surface, so this is mostly a heads-up for later.)
3. You'll authenticate as the **TENANT_ADMIN** seed account (`admin@demomfb.dev` /
   `TenantAdmin!2026`) for all of Section B — customer/risk endpoints are restricted to
   `TENANT_ADMIN`/`COMPLIANCE_OFFICER` (plus `SUPER_ADMIN` for a couple of read-only ones), not to
   `SUPER_ADMIN` for writes, so using the SUPER_ADMIN account here will get you `403`s.

---

## Section A — Testing via the real web app (`http://localhost:3000`)

**There is no Customers page in the web app yet.** This is expected, not a bug: the sidebar's
"Customers" link is present but intentionally disabled until a later UI-focused prompt builds real
pages for it. This section just confirms that's clearly and honestly signposted in the product,
rather than silently missing.

1. Log in at `http://localhost:3000/login` with `admin@demomfb.dev` / `TenantAdmin!2026` (complete
   the MFA code step too if you enabled MFA while following the Prompt 1 guide).
2. Look at the left sidebar. **Expected**: a "Customers" item is visible, visually greyed out, with
   a small pill next to it reading "Soon". Hover over it — a tooltip should say "Coming in a later
   phase". Clicking it does nothing (it's not a real link while disabled).
3. On the dashboard, look at the four stat cards again. **Expected**: the "Customers" card still
   shows a dash (`—`) with the note "Arrives in UI Prompt 2" — confirming the backend work covered
   by this guide (data model, scoring, ingestion) has landed, but the page that would visualize it
   hasn't yet.

Everything else in this module is tested directly against the API via Swagger, below.

---

## Section B — Testing via Swagger UI (`http://localhost:4000/docs`)

### B0. Authorize as TENANT_ADMIN (do this once)

1. Open `http://localhost:4000/docs`.
2. In the **auth** section, click **POST /auth/login**, then **Try it out**.
3. Replace the request body with:
   ```json
   { "email": "admin@demomfb.dev", "password": "TenantAdmin!2026" }
   ```
4. Click **Execute**.
5. **If** the response body shows `"mfaRequired": true` (because you enabled MFA in the Prompt 1
   guide): copy the `mfaToken` value, expand **POST /auth/verify-mfa**, click **Try it out**,
   paste `{ "mfaToken": "PASTE_IT_HERE", "code": "123456" }` (replacing `123456` with the current
   code from your authenticator app), and click **Execute**. Either way, you should now have a
   response containing a real `accessToken`.
6. Copy the `accessToken` value. Scroll to the top of the page, click **Authorize**, paste the
   token into the field, click **Authorize** in the dialog, then **Close**.
7. Every "Execute" click below will now automatically send this token — you won't need to repeat
   this step.

### B1. Create a customer → confirm a risk score is computed automatically

1. In the **customers** section, click **POST /customers**, then **Try it out**.
2. Replace the request body with:
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
4. **Expected**: "Code" `201`. In the response body's `data` object, look for `riskScore` and
   `riskLevel` — **both should already be filled in** (e.g. `"riskScore": 65, "riskLevel":
   "HIGH"`), even though you never supplied them. This is the risk engine running automatically on
   creation, not something you have to trigger separately.
5. Also confirm `"bvn": "*******8901"` in the response — masked by default, not the raw
   `12345678901` you typed in. That's intentional (see B6 for how to see it unmasked).
6. **Write down the `id` value from the response** — you'll paste it into a path field in every
   step below. Swagger doesn't remember it for you between endpoints.
7. **Failure mode**: `409` with `"code": "CUSTOMER_CBS_ID_TAKEN"` means you already created this
   exact customer earlier — either reuse that customer's `id` for the remaining steps, or change
   `cbsCustomerId` to something new and start again. `riskScore: null` would mean the tenant's
   default risk factor configuration didn't seed correctly — check that `pnpm db:seed` ran
   without errors.

### B2. Confirm the customer shows up in a plain list

1. In the **customers** section, click **GET /customers**, then **Try it out**.
2. **Note**: no input fields appear here at all — just an "Execute" button. That's a real, minor
   gap in this endpoint's Swagger documentation: the API actually supports rich filtering and
   typo-tolerant fuzzy name search via query parameters (like `?q=jhon` matching "John Smith" even
   with a typo), but those parameters aren't wired up as fillable fields in Swagger yet. **This
   specific fuzzy-search behavior can't be clicked through in the browser right now** — it's
   covered by the project's automated test suite instead (see `HANDOFF.md`). What you *can* still
   confirm here is the plain, unfiltered list.
3. Click **Execute**.
4. **Expected**: "Code" `200`. The response body has a `data` object which itself contains a
   `data` array (a list-inside-a-list — that's just how paginated results are wrapped) plus a
   `meta` object with `page`/`limit`/`total`. Scroll through the inner `data` array and confirm
   your "John Smith" customer from B1 is in there.

### B3. Update the customer → confirm an automatic re-score

1. Click **PATCH /customers/{id}**, then **Try it out**.
2. A field labeled **id** appears — paste in the customer `id` you saved from B1.
3. Replace the request body with:
   ```json
   { "occupation": "cash-intensive retail", "country": "IR" }
   ```
4. Click **Execute**.
5. **Expected**: "Code" `200`. `occupation` and `country` are both scoring-relevant fields, so this
   should trigger an automatic re-score. Confirm the response's `riskLevel` is now `"CRITICAL"` and
   `riskScore` is `100` (the score is capped at 100 even though the underlying factors would sum to
   more than that — "cash-intensive" is a flagged high-risk occupation keyword, and `IR` is on the
   FATF blacklist).
6. **Optional contrast check**: run the same PATCH again with only `{"phone": "+2348000000000"}`.
   **Expected**: `riskScore`/`riskLevel` are unchanged this time — phone isn't a scoring-relevant
   field, so no re-score should fire.

### B4. Confirm the risk history trail has 2+ entries

1. In the **risk** section, click **GET /customers/{id}/risk-history**, then **Try it out**.
2. Three fields appear: **id** (paste your customer's id), **page** (type `1`), and **limit**
   (type `25`).
3. Click **Execute**.
4. **Expected**: "Code" `200`, `"total": 2` (or more if you did B3's optional contrast check — that
   one doesn't add a history row, since it isn't scoring-relevant). In the `data` array, the first
   (newest) entry should show `"trigger": "CUSTOMER_UPDATED"`, `"score": 100`,
   `"level": "CRITICAL"`, with `previousScore`/`previousLevel` matching B1's original values. The
   second (older) entry should show `"trigger": "INITIAL"`, `"score": 65`, `"level": "HIGH"`,
   `previousScore: null`, `previousLevel: null`.

### B5. Manually trigger a re-score

1. In the **risk** section, click **POST /customers/{id}/rescore**, then **Try it out**.
2. Paste your customer's `id` into the **id** field (there's no request body for this one).
3. Click **Execute**.
4. **Expected**: `200`, and the response is a new risk-history entry with `"trigger": "MANUAL"` and
   a non-null `calculatedBy` (your own user id) — every other trigger type
   (`INITIAL`/`CUSTOMER_UPDATED`/`SCHEDULED`) always has `calculatedBy: null`, so this is the one
   way to see that field populated. Re-run B4's `GET /customers/{id}/risk-history` afterward and
   confirm `total` went up by one.

### B6. View the customer's real, unmasked PII — with a documented Swagger gap

1. Click **GET /customers/{id}/pii**, **Try it out**, paste in your customer's `id`, and click
   **Execute** without changing anything else.
2. **Expected**: "Code" `400`, `error.code`: `"REASON_REQUIRED"`. This endpoint requires a `reason`
   explaining why you're viewing unmasked PII — confirming that requirement is genuinely enforced.
3. **Here's the gap**: this endpoint's `reason` parameter isn't currently declared in Swagger's
   documentation, so there's no fillable field for it in "Try it out" — every click here will
   always send no reason and always get this same `400`. **Actually seeing the unmasked BVN this
   way isn't possible through Swagger's UI as currently documented.** This isn't a real limitation
   of the API (the parameter works fine over HTTP; it's a documentation gap in this one endpoint's
   Swagger annotations), and it isn't in the real web app yet either — so, honestly, there's no
   browser-only way to click through the success path of this endpoint today. It's exercised by
   the automated e2e test suite instead (`customers.e2e-spec.ts`'s PII tests, see `HANDOFF.md`).

### B7. Attempt to soft-delete the customer — same documented gap

1. Click **DELETE /customers/{id}**, **Try it out**, paste in the `id`, and click **Execute**.
2. **Expected**: "Code" `400`, `error.code`: `"REASON_REQUIRED"` — same story as B6: this endpoint
   also requires a `reason` query parameter that Swagger doesn't currently expose as a fillable
   field, so the success path (`204`, customer soft-deleted) can't be driven through this page
   either. Leave the customer as-is; it's not actually deleted, which is fine for this guide's
   purposes.

### B8. CSV batch ingestion — not reachable through either browser surface yet

1. Click **POST /customers/batch**, then **Try it out**.
2. **Expected**: instead of a file-picker control, you'll see a plain JSON text box (pre-filled
   with `{}`). This endpoint accepts a real file upload (multipart form data) at the HTTP level,
   but its Swagger documentation hasn't been annotated to describe that yet, so Swagger renders it
   as if it took a JSON body instead — there's no way to attach an actual CSV file from this page.
3. Combined with Section A confirming there's no Customers page in the web app yet either,
   **CSV batch ingestion genuinely can't be exercised by clicking through a browser right now** —
   don't spend time trying to work around this by hand. It's fully covered by this project's
   automated tests instead, including a 100,000-row performance benchmark — see `HANDOFF.md`'s
   Backend Prompt 2 section for what's been verified there. This is worth revisiting once either
   the Swagger annotations are added to this endpoint or a real Customers/upload page ships.

### B9. Confirm audit log entries for everything that succeeded above

1. In the **audit** section, click **GET /audit-logs**, **Try it out**, type `50` into the
   **limit** field, and click **Execute**.
2. **Expected**: `200`, and among the `data` entries you should be able to find: `customer.create`
   (from B1, with an `afterState` containing your new customer's fields), `customer.update` (from
   B3, with both `beforeState` and `afterState`), and `risk.rescore.manual` (from B5). You will
   **not** see `customer.pii.view` or `customer.delete` entries — B6 and B7 both 400'd before
   reaching the code that would have written those, which is exactly correct: nothing should be
   audited for a request that was rejected before doing anything.

---

## Checklist — Backend Prompt 2 sign-off

- [ ] Sidebar's "Customers" link is visibly disabled with a "Soon" badge; dashboard's Customers
      stat card shows "Arrives in UI Prompt 2" — confirmed honestly absent, not broken
- [ ] Creating a customer via Swagger returns a populated, non-null `riskScore`/`riskLevel`
      automatically, and the BVN is masked in the response
- [ ] The new customer appears in a plain `GET /customers` call
- [ ] Updating a scoring-relevant field (occupation/country) triggers an automatic re-score to
      `CRITICAL`/`100`; a non-scoring field (phone) does not change the score
- [ ] `GET /customers/{id}/risk-history` shows 2+ correctly-ordered entries with the right
      `trigger`/`previousScore`/`previousLevel` values
- [ ] Manual `POST /customers/{id}/rescore` adds a `MANUAL`-trigger entry with a non-null
      `calculatedBy`
- [ ] `GET /audit-logs` shows entries for every write above
- [ ] Confirmed (not assumed) that fuzzy search, PII unmask, soft-delete, and CSV batch upload
      currently can't be exercised through either the web app or Swagger's clickable UI — each for
      a specific, documented reason (missing UI, or a missing Swagger annotation) rather than a
      silent gap
