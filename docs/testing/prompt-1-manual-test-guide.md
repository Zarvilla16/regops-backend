# Manual Test Guide — Backend Prompt 1 (Multi-tenant Foundation, Auth, RBAC, Audit)

This guide is entirely point-and-click: **Section A** uses the real RegOps web app in your
browser at `http://localhost:3000`, and **Section B** uses the Swagger API explorer at
`http://localhost:4000/docs` for anything the web app doesn't have a page for yet. There is no
terminal work below except the one-time bootstrap in "Prerequisites" — after that, close the
terminal window (or just ignore it) and do everything else by clicking.

This reflects what's **actually built and working today**, including a couple of deliberate
product decisions documented in `HANDOFF.md` (e.g. why a SUPER_ADMIN needs an extra header to see
other tenants' data) — you don't need to read that file to follow this guide, but it's there if
something below surprises you and you want the "why."

## Prerequisites (one terminal session, then you're done with it)

1. Make sure Docker Desktop is running, then open a terminal **once**, from the repo root, and run:
   ```
   docker-compose up -d
   ```
2. If this is the first time anyone has set this up: copy each `*.env.example` file to `.env` in
   `apps/api`, `apps/web`, and the repo root.
3. Still in that one terminal:
   ```
   pnpm install
   pnpm build
   pnpm db:migrate
   pnpm db:seed
   pnpm dev
   ```
   `pnpm dev` starts all three apps and keeps running — leave that terminal window open in the
   background (minimize it), but you won't need to type anything else into it.
4. In your browser, confirm two tabs both load:
   - `http://localhost:3000` — the RegOps web app (should redirect you to a login page)
   - `http://localhost:4000/docs` — the Swagger API explorer (a page with sections like `auth`,
     `tenants`, `users`, `audit`)

**Seeded accounts you'll use below** (also printed by `pnpm db:seed` in the terminal):

| Role | Email | Password |
|---|---|---|
| SUPER_ADMIN | `superadmin@regops.dev` | `SuperAdmin!2026` |
| TENANT_ADMIN (tenant: "Demo MFB Limited") | `admin@demomfb.dev` | `TenantAdmin!2026` |
| COMPLIANCE_OFFICER (tenant: "Demo MFB Limited") | `compliance@demomfb.dev` | `Compliance!2026` |

---

## Section A — Testing via the real web app (`http://localhost:3000`)

### A1. Sign in and land on the dashboard

1. Go to `http://localhost:3000`. It should redirect you to `/login`.
2. In the **Email address** field, type `admin@demomfb.dev`.
3. In the **Password** field, type `TenantAdmin!2026`.
4. Click the **Sign in** button.
5. **Expected**: you land on `/dashboard`. Near the top, a dark welcome banner should read
   "Welcome back, Demo" and underneath, "Signed in as TENANT ADMIN · Demo MFB Limited".
6. **Failure mode**: if you're bounced straight back to `/login`, double-check the password
   (case-sensitive) and that `pnpm db:seed` actually ran in the terminal without errors.

### A2. Confirm the dashboard shows real data

Still on `/dashboard`:
1. Look at the row of four small cards below the welcome banner. The first one, "Team members",
   should show a real number (at least 3 — the seeded users) rather than a dash. The other three
   ("Customers", "Screening matches", "Open alerts") correctly show a dash (`—`) with a small note
   like "Arrives in UI Prompt 2/3/5" — that's expected, those modules' UI hasn't been built yet.
2. Below that, look at the "Recent activity" panel. **Expected**: at least one row already, with a
   "When" timestamp, an "Action" pill, an "Entity" column, and an "Actor" column — this is your
   own just-now login (`USER LOGIN SUCCESS` or similar), proving the audit log is real and wired
   into this page, not a mock.
3. Click the small "Refresh" button above the table (with a circular-arrow icon) and confirm the
   table reloads without an error message.

### A3. Toggle the theme

1. In the top-right of the page, click the small round icon button next to your name (a sun or
   moon icon, to the left of your avatar).
2. **Expected**: the whole page's colors flip between light and dark immediately, and the icon
   itself swaps (sun ↔ moon) to reflect the new state. Click it again to flip back.

### A4. Log out

1. Click your name / avatar in the top-right corner to open a dropdown menu.
2. **Expected**: the menu shows your full name, email, and role at the top, then a "Log out" item
   below a divider line.
3. Click **Log out**.
4. **Expected**: you're redirected back to `/login`. Try navigating directly to
   `http://localhost:3000/dashboard` — you should be bounced straight back to `/login` again,
   confirming the session is really gone, not just hidden.

### A5. Test account lockout (using a different seeded account on purpose)

We deliberately use the **COMPLIANCE_OFFICER** account for this check, not the TENANT_ADMIN
account you just used — locking an account for repeated bad passwords ties it up for 30 minutes,
and we still need the TENANT_ADMIN account free for the MFA steps right after this one.

1. On the `/login` page, type `compliance@demomfb.dev` as the email.
2. Type a deliberately wrong password, e.g. `WrongPassword123`.
3. Click **Sign in**. **Expected**: a red error message appears under the form (something like
   "Invalid email or password").
4. Repeat steps 2–3 **four more times** (5 wrong attempts total, all with the same wrong
   password is fine).
5. On this 5th failed attempt or the next one after it, **expected**: the login form disappears
   and is replaced by a lock icon with the message "This account is temporarily locked due to too
   many failed login attempts," plus a note to wait or contact your tenant admin.
6. **Failure mode**: if you never see the locked message after 5–6 tries, something regressed in
   the lockout counter — this should be reliable, not flaky.
7. Leave this account alone for the rest of the guide; it'll unlock itself after 30 minutes.

### A6. Enroll in MFA through the real Settings page

1. Log back in as the TENANT_ADMIN account (`admin@demomfb.dev` / `TenantAdmin!2026`) — this one
   was never touched by the lockout test, so it should log you straight in to `/dashboard`.
2. In the left sidebar, click **Settings**.
3. **Expected**: a "Profile" card showing your name/email/role, a "Two-factor authentication"
   card, and an "Appearance" card (the same light/dark toggle as A3, just relocated here too).
4. In the "Two-factor authentication" card, click **Enable MFA**.
5. **Expected**: a QR code image appears, with a "Confirmation code" input box underneath.
6. Open an authenticator app on your phone (Google Authenticator, Microsoft Authenticator, Authy,
   1Password, or similar — any TOTP app works) and scan the QR code on your screen with it.
7. Your authenticator app now shows a rotating 6-digit code for "RegOps". Type that code into the
   **Confirmation code** box on the Settings page.
8. Click **Confirm and enable**.
9. **Expected**: the card now shows a green "Enabled" checkmark line instead of the QR code, and a
   new "Enter a code to disable MFA" box appears below it (you don't need to use this — just
   confirm it's there, proving MFA is genuinely on now, not just visually indicated).
10. **Failure mode**: "That code didn't match. Try again." almost always means the 30-second code
    expired before you finished typing it — get a fresh code from your app and retry immediately.

### A7. Log out and log back in — confirm MFA is now actually required

1. Log out the same way as A4 (avatar menu → Log out).
2. On `/login`, sign in again with `admin@demomfb.dev` / `TenantAdmin!2026`.
3. **Expected this time**: instead of landing on `/dashboard`, you're taken to a separate
   "Enter verification code" page with six empty boxes.
4. Open your authenticator app, get the current 6-digit code for "RegOps", and type the digits —
   the boxes auto-advance as you type, and the form submits automatically once all six are filled
   (there's no separate "submit" button to click).
5. **Expected**: you land on `/dashboard` as normal.
6. **Failure mode**: "That code didn't match" and the boxes clearing themselves means the code
   expired mid-entry — wait for your app to show a fresh one and type quickly.

### A8. Confirm the new events show up in Recent activity

1. Still on `/dashboard`, click the **Refresh** button on the "Recent activity" panel again.
2. **Expected**: you should now see additional rows compared to A2, including entries for your
   MFA enrollment and your two most recent logins. The exact wording varies, but you should be
   able to spot at least: a "login failed"-style entry (from A5's lockout test — this tenant's
   audit log includes every user in it, not just you), an "mfa enabled" entry, and one or more
   "login success" entries.

---

## Section B — Testing via Swagger UI (`http://localhost:4000/docs`)

Everything below either has no page in the web app yet (tenant management) or shows more detail
than the web app's UI exposes (full audit log fields, raw 403/401 responses). None of this
requires typing a single terminal command — just clicking through the Swagger page.

### B0. Log in as SUPER_ADMIN and authorize Swagger (do this once)

1. Open `http://localhost:4000/docs` in your browser.
2. Find the **auth** section and click on the row labeled **POST /auth/login** to expand it.
3. Click the **Try it out** button on the right side of the expanded section.
4. A text box appears under "Request body." Clear whatever is in it and paste in:
   ```json
   { "email": "superadmin@regops.dev", "password": "SuperAdmin!2026" }
   ```
5. Click the blue **Execute** button.
6. Scroll down to **Server response**. **Expected**: the "Code" column shows `200`, and the
   "Response body" box shows something like:
   ```json
   { "success": true, "data": { "mfaRequired": false, "accessToken": "eyJ...", "refreshToken": "eyJ...", "user": { "role": "SUPER_ADMIN", ... } } }
   ```
7. **Select and copy** the `accessToken` value (the long string — everything between the quotes,
   no quotes included). Also note the `refreshToken` value somewhere (a sticky note, a scratch text
   file) — you'll need both later in this section.
8. Scroll to the **top of the Swagger page**. Click the **Authorize** button (it has a padlock
   icon, near the page title).
9. A dialog appears with a field under a heading like "bearerAuth (http, Bearer)". Paste the
   `accessToken` value into that field (just the token — no `Bearer` prefix, no quotes).
10. Click the **Authorize** button inside the dialog, then click **Close**.
11. From now on, every endpoint you "Execute" in Swagger will automatically include this token —
    you won't need to repeat the login/paste steps until you deliberately switch identity later
    in this guide (B4).

### B1. Create a second tenant (SUPER_ADMIN-only — no web app page for this yet)

1. Find the **tenants** section and click **POST /tenants** to expand it.
2. Click **Try it out**.
3. Replace the request body with:
   ```json
   { "name": "Second Test Bank", "type": "MFB" }
   ```
4. Click **Execute**.
5. **Expected**: "Code" `201`, and the response body's `data` object contains a new `id` and
   `"name": "Second Test Bank"`. This confirms tenant creation works, and it's SUPER_ADMIN-only
   with nothing in the web app currently exposing it — that's expected, not a bug.

### B2. Confirm SUPER_ADMIN, without any special header, only sees their own tenant's users

This checks a deliberate design decision: a SUPER_ADMIN doesn't automatically see every tenant's
data just because of their role — they need to explicitly ask to cross tenants (a feature not
exercised in this guide, since it has no UI yet either).

1. Find the **users** section and click **GET /users** to expand it.
2. Click **Try it out**, then click **Execute** (no fields to fill in — this endpoint takes no
   parameters).
3. **Expected**: "Code" `200`, and the `data` array contains only users belonging to the
   SUPER_ADMIN's own tenant ("RegOps Platform") — you should **not** see `admin@demomfb.dev`,
   `compliance@demomfb.dev`, or anyone from "Second Test Bank" in this list, even though those
   users definitely exist (you were just logged in as one of them in Section A).

### B3. Refresh-token reuse is detected and revokes the whole session

1. Find **POST /auth/refresh** in the **auth** section, expand it, click **Try it out**.
2. Paste in the request body, using the `refreshToken` value you saved from step B0:
   ```json
   { "refreshToken": "PASTE_THE_TOKEN_FROM_B0_HERE" }
   ```
3. Click **Execute**. **Expected**: `200`, with a **new** `accessToken` and `refreshToken` in the
   response. Copy this new `refreshToken` somewhere too — call it "token #2."
4. Now click **Execute** again **without changing the request body** — you're resubmitting the
   *same original* (now-rotated-away) token from B0.
5. **Expected**: "Code" `401`, response body's `error.code` is `"REFRESH_TOKEN_REUSED"`, with a
   message mentioning that all sessions have been revoked.
6. Now replace the request body with token #2 (the one you got in step 3) and click **Execute**
   one more time.
7. **Expected**: **also** `401`, this time `error.code` is `"INVALID_REFRESH_TOKEN"` — confirming
   that reusing an old token doesn't just fail itself, it revokes the *entire* chain of tokens
   descended from it, including the newer one that hadn't been "reused" at all.
8. You'll need to log in again via B0's steps (or the web app) to get a fresh, working session
   after this — that's expected, you just deliberately broke this one.

### B4. Switch identity to TENANT_ADMIN and confirm role-based 403

1. Repeat B0's login steps, but this time with `admin@demomfb.dev` / `TenantAdmin!2026` in the
   request body.
2. **Expected this time**: since you enabled MFA on this account in Section A6, the response is
   `{"success":true,"data":{"mfaRequired":true,"mfaToken":"..."}}` — no access token yet.
3. Copy the `mfaToken` value. Expand **POST /auth/verify-mfa**, click **Try it out**, and paste:
   ```json
   { "mfaToken": "PASTE_MFA_TOKEN_HERE", "code": "123456" }
   ```
   replacing `123456` with the current 6-digit code from your authenticator app for this account.
4. Click **Execute**. **Expected**: `200`, with a real `accessToken` this time.
5. Copy that `accessToken`. Scroll up, click **Authorize**, click the **Logout** button next to
   the currently-authorized entry (to clear the SUPER_ADMIN token), paste in the new TENANT_ADMIN
   token, click **Authorize**, then **Close**.
6. Expand **POST /tenants** again, click **Try it out**, paste any body (e.g.
   `{"name":"Should Not Work","type":"MFB"}`), and click **Execute**.
7. **Expected**: "Code" `403` — TENANT_ADMIN is not allowed to create tenants, confirming this is
   a real, enforced restriction and not just a hidden button in the web app.

### B5. Inspect full audit log detail (more than the dashboard table shows)

1. Still authorized as TENANT_ADMIN, find the **audit** section and click **GET /audit-logs**.
2. Click **Try it out**. A **limit** field appears — type `50` into it.
3. Click **Execute**.
4. **Expected**: "Code" `200`, and the response body's `data` array is noticeably more detailed
   than the dashboard's "Recent activity" table — each entry has `ipAddress`, `userAgent`, and a
   precise ISO `createdAt` timestamp, none of which the dashboard displays. Scroll through and
   confirm you can find: several `user.login.failed` entries (from A5's lockout test),
   `user.mfa.enabled` (from A6), and multiple `user.login.success` entries (from A1, A7, and B4).

---

## Checklist — Backend Prompt 1 sign-off

- [ ] Signing in through the real login page lands on `/dashboard` with the correct name/tenant
- [ ] Dashboard's "Recent activity" table shows real audit data, and "Refresh" reloads it
- [ ] Theme toggle switches the whole page's colors
- [ ] Logging out via the avatar menu returns to `/login` and blocks direct access to `/dashboard`
- [ ] 5 wrong passwords in the real login form show a locked-account message in the UI
- [ ] MFA can be fully enrolled through `/settings` (QR code → phone app → confirmation code)
- [ ] After enabling MFA, login redirects to the 6-digit code page before granting access
- [ ] (Swagger) Creating a tenant works for SUPER_ADMIN and returns `403` for TENANT_ADMIN
- [ ] (Swagger) SUPER_ADMIN without an override header only sees their own tenant's users
- [ ] (Swagger) Reusing a rotated-away refresh token returns `REFRESH_TOKEN_REUSED` and invalidates
      the entire token chain, including newer tokens
- [ ] (Swagger) `GET /audit-logs` shows detailed entries (ip/user-agent/timestamp) for every
      action performed above
