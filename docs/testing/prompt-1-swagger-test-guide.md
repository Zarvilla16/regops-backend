# Swagger Test Guide — Backend Prompt 1 (Multi-tenant Foundation, Auth, RBAC, Audit)

A pure click-by-click walkthrough of every Prompt 1 endpoint, done entirely inside the Swagger API
explorer at `http://localhost:4000/docs`. No curl, no terminal commands, and no reference to the
real web app at `localhost:3000` — this guide only exists inside that one browser tab.

**Before you start**: `docker-compose up -d` and `pnpm dev` need to already be running (from
whatever terminal set up the project) so that `http://localhost:4000/docs` loads. That's the only
non-Swagger step in this entire guide.

**Seeded accounts you'll need** (created by `pnpm db:seed`):

| Role | Email | Password |
|---|---|---|
| SUPER_ADMIN | `superadmin@regops.dev` | `SuperAdmin!2026` |
| TENANT_ADMIN (tenant: "Demo MFB Limited") | `admin@demomfb.dev` | `TenantAdmin!2026` |
| COMPLIANCE_OFFICER (tenant: "Demo MFB Limited") | `compliance@demomfb.dev` | `Compliance!2026` |

**One general tip for the whole guide**: access tokens expire after 15 minutes. If any step
suddenly returns `401` even though you're sure you authorized correctly, your token has simply
expired — just repeat the relevant `POST /auth/login` step to get a fresh one and re-Authorize.

---

## 1. `POST /auth/login` — trigger account lockout, then confirm it blocks even the correct password

We deliberately do this on the **COMPLIANCE_OFFICER** account, not TENANT_ADMIN — locking an
account ties it up for 30 minutes, and the rest of this guide needs a TENANT_ADMIN session that
isn't locked.

1. In the **auth** section, click on **POST /auth/login** to expand it.
2. Click **Try it out**.
3. Paste this into the request body box:
   ```json
   { "email": "compliance@demomfb.dev", "password": "WrongPassword123" }
   ```
4. Click **Execute**.
5. **Expected**: "Code" `401`, response body `{"success":false,"error":{"code":"INVALID_CREDENTIALS", ...}}`.
6. Click **Execute** again (same body, unchanged) **four more times** — five wrong attempts total.
   Each one should return the same `401 INVALID_CREDENTIALS`.
7. Now change the request body to the **correct** password:
   ```json
   { "email": "compliance@demomfb.dev", "password": "Compliance!2026" }
   ```
   and click **Execute** one more time.
8. **Expected — and this is the important, slightly counter-intuitive part**: you still get
   `423`, `{"success":false,"error":{"code":"ACCOUNT_LOCKED", "message":"This account is
   temporarily locked due to too many failed login attempts."}}` — **even though the password was
   correct this time**. That's not a bug: once 5 failures happen, the account locks for 30 minutes
   regardless of what password you try next. Leave this account alone; it unlocks itself.
9. **Failure mode**: if you never see `423` after 5–6 attempts and instead just keep getting `401`
   forever, the lockout counter isn't incrementing — that would be a real regression, not
   expected behavior.

## 2. `POST /auth/login` — sign in as TENANT_ADMIN, and set up "Authorize" for the rest of the guide

1. Click **POST /auth/login** again (it may still be expanded from step 1), click **Try it out**,
   and replace the body with:
   ```json
   { "email": "admin@demomfb.dev", "password": "TenantAdmin!2026" }
   ```
2. Click **Execute**.
3. **Expected**: `200`, and the response body looks like:
   ```json
   { "success": true, "data": { "mfaRequired": false, "accessToken": "eyJ...", "refreshToken": "eyJ...", "user": { "role": "TENANT_ADMIN", "mfaEnabled": false, ... } } }
   ```
4. **Copy the `accessToken` value** (just the string between the quotes — no quotes, no `Bearer`
   prefix). Also copy the `refreshToken` value somewhere you can paste it back in later (a scratch
   text file, a sticky note) — you'll need it in step 9.
5. Scroll to the top of the Swagger page and click the **Authorize** button (padlock icon, near
   the page title).
6. In the dialog that appears, paste the `accessToken` into the field under "bearerAuth", click
   **Authorize**, then click **Close**.
7. **From this point on, every endpoint's "Execute" automatically includes this token** — you
   won't need to touch the Authorize button again until you deliberately switch identity (step 11).
8. **Failure mode**: if step 3 instead returned `{"mfaRequired": true, "mfaToken": "..."}` with no
   `accessToken`, that means MFA is already enabled on this account from an earlier run of this
   guide — skip ahead to step 8 (`POST /auth/verify-mfa`) using this `mfaToken`, get an
   `accessToken` from there instead, and come back to step 5 above.

## 3. `GET /auth/me` — confirm the token identifies the right user and tenant

1. Click **GET /auth/me** to expand it, then click **Try it out**.
2. Click **Execute** (no fields to fill in).
3. **Expected**: `200`, response body's `data.user.email` is `"admin@demomfb.dev"`,
   `data.user.role` is `"TENANT_ADMIN"`, and `data.tenant.name` is `"Demo MFB Limited"`.
4. **Failure mode**: `401` here means the Authorize step didn't take — re-do step 2's copy/paste
   into the Authorize dialog.

## 4. `POST /auth/mfa/setup` — begin MFA enrollment

1. Click **POST /auth/mfa/setup**, then **Try it out**.
2. Click **Execute** (no request body needed for this one).
3. **Expected**: `200`, response body contains `data.secret` (a short uppercase string) and
   `data.qrCodeDataUrl` (a very long string starting with `data:image/png;base64,`).
4. To actually scan this: copy the entire `qrCodeDataUrl` value, open a **new browser tab**, paste
   it directly into the address bar, and press Enter — the browser will render it as an actual QR
   code image. Scan that image with an authenticator app on your phone (Google Authenticator,
   Microsoft Authenticator, Authy, 1Password, or any TOTP app). Keep that browser tab open in case
   you need to re-scan.
5. **Failure mode**: if `qrCodeDataUrl` doesn't render as an image when pasted into the address
   bar, double check you copied the *entire* string (it's long, and an accidental truncation is
   the most common cause).

## 5. `POST /auth/mfa/enable` — confirm the enrollment with a live code

1. Click **POST /auth/mfa/enable**, then **Try it out**.
2. Open your authenticator app, find the current 6-digit code for "RegOps", and paste it in:
   ```json
   { "code": "123456" }
   ```
   (replace `123456` with your app's actual current code).
3. Click **Execute** — do this quickly, TOTP codes only last ~30 seconds.
4. **Expected**: `200`, `{"success":true,"data":{"mfaEnabled":true}}`.
5. **Failure mode**: `401 INVALID_MFA_CODE` almost always means the code expired between you
   reading it and clicking Execute — grab a fresh one from your app and try again immediately.
   `409 MFA_SETUP_REQUIRED` means step 4 wasn't actually completed first.

## 6. `POST /auth/logout` — end the session

1. Click **POST /auth/logout**, then **Try it out**.
2. Paste in the `refreshToken` you saved back in step 2:
   ```json
   { "refreshToken": "PASTE_THE_TOKEN_FROM_STEP_2_HERE" }
   ```
3. Click **Execute**.
4. **Expected**: "Code" `204`, and the response body area is empty — that's correct for a `204 No
   Content` response, not an error.
5. **Failure mode**: any other status code here would mean the refresh token you pasted doesn't
   match what you actually got in step 2 — re-copy it carefully.

## 7. `POST /auth/login` — log in again and confirm MFA is now required

1. Click **POST /auth/login**, **Try it out**, and use the same TENANT_ADMIN credentials as step 2:
   ```json
   { "email": "admin@demomfb.dev", "password": "TenantAdmin!2026" }
   ```
2. Click **Execute**.
3. **Expected — this is the key difference from step 2**: `200`, but this time
   `{"success":true,"data":{"mfaRequired":true,"mfaToken":"eyJ...","...":"..."}}` — **no**
   `accessToken`/`refreshToken` yet. Enabling MFA in step 5 changed this endpoint's behavior for
   this account, exactly as intended.
4. Copy the `mfaToken` value for the next step.

## 8. `POST /auth/verify-mfa` — complete the login with a fresh code

1. Click **POST /auth/verify-mfa**, then **Try it out**.
2. Get a fresh code from your authenticator app, and paste:
   ```json
   { "mfaToken": "PASTE_MFA_TOKEN_FROM_STEP_7_HERE", "code": "123456" }
   ```
   (replacing `123456` with the live code).
3. Click **Execute**.
4. **Expected**: `200`, a full login response again — `data.accessToken`, `data.refreshToken`,
   and this time `data.user.mfaEnabled` is `true`.
5. **Copy this new `accessToken`** and re-authorize: click **Authorize** at the top, click
   **Logout** on the currently-authorized entry, paste in this new token, click **Authorize**,
   then **Close**. (Your old token from step 2 still works until it expires, but this new one
   reflects the post-MFA session.) Also copy this new `refreshToken` — you'll use it next.
6. **Failure mode**: `401 INVALID_MFA_TOKEN` means the challenge token from step 7 expired (it's
   only valid 5 minutes) — repeat step 7 to get a fresh one.

## 9. `POST /auth/refresh` — confirm reuse of a rotated token is detected

1. Click **POST /auth/refresh**, then **Try it out**.
2. Paste the `refreshToken` you just got in step 8:
   ```json
   { "refreshToken": "PASTE_TOKEN_FROM_STEP_8_HERE" }
   ```
3. Click **Execute**.
4. **Expected**: `200`, with a **new** `accessToken` and `refreshToken` in the response — copy
   this new `refreshToken` too (call it "token #2" in your head).
5. Now click **Execute** again **without changing the request body** — you're resending the exact
   same (now already-used) token from step 8.
6. **Expected**: `401`, `{"success":false,"error":{"code":"REFRESH_TOKEN_REUSED", "message":"This
   refresh token has already been used. All sessions have been revoked."}}`.
7. **Bonus check** (optional but informative): replace the body with token #2 from step 4 and
   click **Execute** once more. **Expected**: also `401`, this time `"code":"INVALID_REFRESH_TOKEN"`
   — reusing an old token doesn't just fail itself, it revokes the *entire* chain descended from
   it, including the newer token that was never actually reused.
8. **Note**: after this, both refresh tokens are dead. Repeat step 2 (or 7+8) if you need a
   working session again afterward.

## 10. `GET /audit-logs` — confirm every action above left a trail

1. Click **GET /audit-logs**, then **Try it out**.
2. A **limit** field appears — type `50` into it.
3. Click **Execute**.
4. **Expected**: `200`, and the `data` array includes entries you can match back to almost every
   step above: several `user.login.failed` (step 1's five failures), `user.login.success`
   (steps 2, 8), `user.mfa.enabled` (step 5). Each entry also has `ipAddress`, `userAgent`, and a
   precise `createdAt` timestamp.
5. **Failure mode**: an empty `data` array despite the steps above succeeding usually means you're
   authorized as the wrong identity — audit logs are tenant-scoped, so make sure you're still
   authorized as `admin@demomfb.dev` (re-check with `GET /auth/me` from step 3 if unsure).

## 11. `POST /tenants` — SUPER_ADMIN can create tenants; TENANT_ADMIN cannot

**11a. As SUPER_ADMIN:**

1. Click **POST /auth/login**, **Try it out**, and log in fresh as SUPER_ADMIN:
   ```json
   { "email": "superadmin@regops.dev", "password": "SuperAdmin!2026" }
   ```
2. Click **Execute**. **Expected**: `200`, `mfaRequired: false` (this account was never enrolled
   in MFA during this guide), with a real `accessToken`.
3. Copy that `accessToken`. Click **Authorize** at the top, click **Logout** on the currently
   TENANT_ADMIN-authorized entry, paste in the SUPER_ADMIN token, click **Authorize**, **Close**.
4. Click **POST /tenants**, **Try it out**, and paste:
   ```json
   { "name": "Second Test Bank", "type": "MFB" }
   ```
5. Click **Execute**.
6. **Expected**: `201`, response body's `data` object has a new `id` and
   `"name": "Second Test Bank"`.

**11b. As TENANT_ADMIN (confirm the 403):**

7. You still have the TENANT_ADMIN `accessToken` copied from step 8 earlier in this guide. Click
   **Authorize**, **Logout** the SUPER_ADMIN entry, paste the TENANT_ADMIN token back in,
   **Authorize**, **Close**. (If that token has since expired, repeat steps 7–8 above to get a
   fresh one.)
8. Click **POST /tenants** again, **Try it out**, and paste any body, e.g.:
   ```json
   { "name": "Should Not Work", "type": "MFB" }
   ```
9. Click **Execute**.
10. **Expected**: `403 Forbidden` — tenant creation is SUPER_ADMIN-only, and this confirms it's a
    real, server-enforced restriction, not just a hidden option somewhere.

## 12. `GET /users` — confirm SUPER_ADMIN, without any special header, only sees their own tenant

1. Re-authorize back to the SUPER_ADMIN token from step 11a (Authorize → Logout → paste it back
   in → Authorize → Close).
2. Click **GET /users**, then **Try it out**.
3. Click **Execute** (no fields to fill in).
4. **Expected**: `200`, and the `data` array contains only users belonging to the SUPER_ADMIN's
   own tenant ("RegOps Platform") — you should **not** see `admin@demomfb.dev`,
   `compliance@demomfb.dev`, or anyone from "Second Test Bank" (created in step 11a) in this list,
   even though all of those users definitely exist. This confirms tenant isolation applies even to
   the most senior role by default — SUPER_ADMIN has to explicitly ask to cross tenants (a
   mechanism not exercised in this guide), it doesn't happen automatically just from the role.
5. **Failure mode**: seeing users from other tenants here would be a serious regression — this is
   the core multi-tenancy guarantee this whole module exists to provide.

---

## Checklist — Backend Prompt 1 Swagger sign-off

- [ ] 5 wrong passwords lock the account; the correct password also 423s while still locked
- [ ] Logging in returns a real `accessToken`; "Authorize" makes it apply to every later request
- [ ] `GET /auth/me` confirms the right user/tenant
- [ ] MFA setup returns a scannable QR code; enabling with a live code succeeds
- [ ] After enabling MFA, login returns `mfaRequired: true` until `verify-mfa` succeeds
- [ ] Reusing an already-rotated refresh token returns `REFRESH_TOKEN_REUSED` and invalidates the
      entire token chain, including newer tokens issued after it
- [ ] `GET /audit-logs` shows detailed entries (ip/user-agent/timestamp) for every action above
- [ ] `POST /tenants` succeeds for SUPER_ADMIN (`201`) and is rejected for TENANT_ADMIN (`403`)
- [ ] `GET /users` as SUPER_ADMIN (no override header) shows only their own tenant's users
