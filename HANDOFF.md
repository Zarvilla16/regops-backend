# RegOps Phase 0 — Handoff

Originally written at the end of the initial scaffolding session, when this sandbox had no Docker
and nothing had run against a real database. **Updated after a follow-up session where Docker
became available** — the full stack was actually run for the first time: migrations, seed, all 18
e2e tests, and a manual walk through login → create tenant → create user → view audit logs via
curl. That run surfaced several real, previously-invisible bugs (see below); all are now fixed and
the fixes are verified, not just written. Read this before continuing work.

## What's been built

Full monorepo scaffold per the Prompt 1 spec:

- **Root**: Turborepo + pnpm workspaces, `turbo.json`, `.gitignore`, `.editorconfig`,
  `docker-compose.yml` (postgres/redis/mailhog), `.github/workflows/ci.yml`.
- **`packages/config`**: shared flat ESLint config (`eslint-preset.js`) + base `tsconfig.json`.
- **`packages/shared`**: `TenantType`/`TenantStatus`/`UserRole`/`UserStatus` enums,
  `MFA_MANDATORY_ROLES`, DTO/response types shared between api and web.
- **`packages/db`**: TypeORM entities (`Tenant`, `User`, `RefreshToken`, `AuditLog`,
  `IdempotencyKey`), `InitialSchema` migration (tables, enums, quarterly `audit_log` partitioning
  + `create_audit_log_partition()` helper function), `RowLevelSecurity` migration (RLS policies +
  `REVOKE UPDATE, DELETE ON audit_log FROM regops_app`), and `seed.ts`.
- **`apps/api`** (NestJS): `TenantContextMiddleware` (per-request `QueryRunner` + RLS session
  vars), auth module (JWT access/refresh, argon2id, TOTP MFA via `otplib`, lockout, refresh
  rotation + theft-chain revocation), tenants module (SUPER_ADMIN-only), users module
  (tenant-scoped CRUD), audit module, global exception filter / response interceptor /
  idempotency interceptor / audit interceptor, Swagger at `/docs`.
- **`apps/worker`**: BullMQ skeleton with one real job — recurring `audit_log` partition
  maintenance — plus an HTTP health-check listener.
- **`apps/web`** (Next.js 15): login → MFA → dashboard flow, Zustand auth store (access token in
  memory/sessionStorage only), refresh token held in an httpOnly cookie via two small BFF route
  handlers (`/api/session`, `/api/session/refresh`), middleware-gated `(app)` routes.
- **Tests**: `apps/api/test/{auth,tenant-isolation,audit}.e2e-spec.ts` plus one real unit test
  (`env.validation.spec.ts`) and a shared fixture helper (`test/utils/test-app.ts`).

`pnpm lint`, `pnpm typecheck`, `pnpm build`, and `pnpm test` all pass clean across every package.
**As of this session, `pnpm test:e2e` also passes clean — all 18 tests across
`auth`/`tenant-isolation`/`audit` e2e specs, run against the real `docker-compose` Postgres.** A
manual curl walkthrough of login → `POST /tenants` → `POST /users` (with `X-Tenant-Override`) →
`GET /audit-logs` also succeeded end-to-end, confirming the literal Definition-of-Done acceptance
path works.

## Critical bugs found once Docker became available (all fixed)

None of these were visible in the previous, Docker-less session — they only surface against a real
Postgres. Roughly in the order they were found:

1. **TypeORM's CLI entry point assumes an ESM project.** `typeorm/cli.js` loads the data source
   file via dynamic `import()`, which follows Node ESM resolution rules (no extension-less
   relative imports) even though this project is CommonJS. Fixed by pointing `migrate:run` /
   `migrate:revert` / `migrate:generate` at `typeorm/cli-ts-node-commonjs.js` instead, and — since
   that still hit a separate, flaky ts-node/type-checking interaction — by having those scripts
   run `pnpm build` first and pass the **compiled** `dist/data-source.js` to the plain
   `typeorm/cli.js` (a `.js` file needs no ESM/CJS detection). See `packages/db/package.json`.
2. **A stale `apps/api/tsconfig.tsbuildinfo` made `tsc` silently emit nothing.** With
   `"incremental": true`, deleting `dist/` without also deleting the buildinfo cache convinces
   `tsc` the (now-gone) output is already up to date, so it exits 0 having written nothing.
   Gitignored already; just remove it if a build ever produces an empty/missing `dist/`.
3. **Port 5432 was already claimed by a native Windows PostgreSQL service** (`postgresql-x64-18`),
   alongside Docker Desktop's own forwarding on the same port — host connections silently landed on
   the native install (which has none of the `regops_admin`/`regops_app` roles), not the container.
   Fixed by remapping `docker-compose.yml` to publish Postgres on host port **5433** and updating
   every `DATABASE_URL`/`DATABASE_ADMIN_URL` in the `.env.example` files accordingly. This is a
   local-environment fix, not a spec change — if you're on a machine without a conflicting native
   Postgres, 5432 would have worked fine, but 5433 is now the checked-in default everywhere.
4. **`apps/api/src/main.ts` called `bootstrap()` unconditionally at module scope.** e2e tests
   import `configureApp` from this same file (by design, to reuse app setup), so merely importing
   it also booted a second, real HTTP server on port 4000 — and with three e2e spec files running
   in parallel Jest workers, they collided (`EADDRINUSE`). Fixed with a `require.main === module`
   guard around the `bootstrap()` call.
5. **The big one: `set_config(key, value, true)` outside of an explicit transaction doesn't
   persist to the next query on the same connection.** The third argument (`is_local`) scopes the
   setting to the current transaction; without one, each `queryRunner.query()` call is its own
   autocommit statement, so `app.current_tenant_id`/`app.bypass_rls` were being discarded
   immediately after the single `SET` statement that set them; every *later* query on that same
   connection — every real read/write in the request — ran with RLS context unset, meaning
   `tenant_id = NULL` (never true) silently filtered out every row. This affected essentially all
   RLS-protected reads/writes application-wide, not just one endpoint. Fixed by wrapping the whole
   unit of work in a real transaction:
   - `TenantContextMiddleware` now opens the transaction right after `connect()`, before the `SET`.
   - `AuthService.withBypassQueryRunner()` and `AuthService.refresh()` do the same.
   - Per-service nested `startTransaction()`/`commitTransaction()` calls (e.g. `UsersService`) still
     work unchanged — TypeORM correctly turns these into SAVEPOINTs when a transaction is already
     active, so nothing about the existing atomic-write pattern needed to change.
   - Committing had to move **out of** the middleware's `res.on("finish")` handler and **into** a
     new `TransactionInterceptor` (registered as the outermost `APP_INTERCEPTOR`). `finish` fires
     only after the response is already written to the client, so committing there would let a
     caller see a 200 for a write that hadn't actually committed yet (and raced with test teardown
     destroying the connection pool mid-commit). The interceptor commits inside the RxJS pipeline,
     before Nest hands the response back to Express. The middleware's `res.on("finish")` still
     exists, but now only as a safety-net rollback+release for the rare case a request never
     reaches any interceptor at all (e.g. a path Express 404s with no matching controller).
6. **A related Postgres quirk needed its own fix, independent of #5.** Even with transactions
   fixed, `current_setting('app.current_tenant_id', true)` returns an **empty string**, not `NULL`,
   on a connection where that custom GUC has ever been `SET LOCAL`'d before — even after that
   transaction committed and ended. Since connections are pooled and reused across unrelated
   requests, any request that doesn't set `current_tenant_id` at all (e.g. `AuthService.login`'s
   bypass-only path) could reuse a connection previously touched by a tenant-scoped request, hit
   `''::uuid`, and 500. Fixed with a new forward-only migration
   (`1700000002000-FixTenantIsolationEmptyStringCast.ts`) that recreates the `tenant_isolation`
   policy using `NULLIF(current_setting(...), '')::uuid` instead of a bare cast.
7. **Refresh tokens could sign identically when issued in the same second.** JWT signing is
   deterministic (HMAC) for identical header+payload+secret; two tokens for the same user with the
   same claims and the same truncated-to-seconds `iat` produced byte-identical tokens, defeating
   rotation/reuse-detection (both would hash the same). Fixed by adding a random `jti` claim to
   every refresh token.
8. **Audit atomicity vs. control flow conflict in `login()`/`verifyMfa()`.** Once
   `withBypassQueryRunner` correctly rolled back on any thrown error (needed for genuine failures),
   it also rolled back the deliberate `UnauthorizedException`/`LockedException` throws used for
   *expected* auth failures — wiping out the very failed-attempt audit row / lockout counter update
   those branches exist to persist. Fixed by having the transactional callback return a tagged
   result (`{ outcome: "invalid" | "locked" | "mfa" | "success", ... }`) instead of throwing, so
   the wrapper always commits normally; `login()`/`verifyMfa()` throw the actual HTTP exception
   only after the commit has happened.
9. **Two test bugs** (not app bugs): `tenant-isolation.e2e-spec.ts` and `audit.e2e-spec.ts` each
   construct an ad-hoc raw `DataSource` with only `[UserEntity, ...]` to test RLS directly via raw
   SQL — but `UserEntity` has a `@ManyToOne` relation to `TenantEntity`, which TypeORM needs
   registered too in order to build the relation's metadata. Fixed by adding `TenantEntity` to both
   entities arrays.
10. **`apps/api`'s `dev` script (`nest start --watch`) raced its own compiler on cold start** —
    intermittently `Error: Cannot find module '.../dist/main'` when the child process launched
    before `nest-cli`'s watcher had finished writing that first compile to disk (more likely with
    `deleteOutDir: true` in `nest-cli.json`, which removes `dist/` at the start of every rebuild).
    Fixed by replacing the script with `tsc-watch -p tsconfig.json --onSuccess "node dist/main.js"`
    (new devDependency): `tsc-watch` only runs the given command after a compile has actually
    succeeded, on cold start and on every subsequent recompile, and kills/restarts it correctly on
    each change — verified both a clean cold start and a hot-reload after editing `main.ts`.

None of the original "Deviations from the spec" below were affected by this — they're unchanged.

## Deviations from the Backend Prompt 1 spec (and why)

1. **SUPER_ADMIN `bypass_rls` is keyed off the `X-Tenant-Override` header, not merely the role.**
   The spec's pseudocode (§6.3) sets `bypass_rls = (role === SUPER_ADMIN)` unconditionally, but
   that contradicts its own test requirement in §9.2 ("Without the override header, even
   SUPER_ADMIN sees only their primary tenant"). Implemented as: bypass only when the caller is
   SUPER_ADMIN **and** supplies the override header; otherwise SUPER_ADMIN is scoped like anyone
   else. See `TenantContextMiddleware`.

2. **`TenantContextMiddleware` independently decodes the JWT.** Nest's pipeline runs middleware
   *before* guards, so `req.user` is not yet populated by Passport/`JwtAuthGuard` when the
   middleware runs. The middleware does its own lightweight `jwtService.verify()` to establish RLS
   context early; `JwtAuthGuard` still independently re-verifies in the guard phase and is what
   actually rejects unauthenticated requests with 401. Verified twice, by design — documented in
   the middleware's own comment block.

3. **`@Auditable()` / `AuditInterceptor` moved to the controller layer, not the service layer.**
   §6.6's pseudocode shows the decorator on a *service* method. Because the audit row must be
   written atomically inside the same DB transaction as the business write (non-negotiable #2),
   and only the service method owns that transaction boundary, the atomicity-critical paths
   (`user.create`, `user.update`, all login/MFA audit entries) call
   `AuditService.record(queryRunner, ...)` **explicitly inside the service method's transaction**
   instead. `@Auditable()` + `AuditInterceptor` still exist and work, but are scoped down to a
   best-effort convenience for simple, non-transactional writes (e.g. would suit a future
   create-only endpoint with no "before" state) — see the doc comment on
   `common/decorators/auditable.decorator.ts`.

4. **Login is by email only** (no tenant selector in `LoginDto`). The schema enforces email
   uniqueness *per tenant* (functional index on `(tenant_id, lower(email))`), so a global,
   tenant-less login can't disambiguate if the same email were ever provisioned in two tenants —
   `AuthService.login()` treats >1 match as `INVALID_CREDENTIALS`. Fine for phase 0 (seed data
   never collides); flagged as a limitation rather than solved, since solving it (subdomain
   routing, or a tenant-id field on login) is a product decision, not an infra one.

5. **Account lockout window uses `user.updatedAt` as a proxy for "last failed attempt".** The
   spec's schema has `failed_login_count` and `locked_until` but no dedicated
   last-failed-attempt timestamp, so "5 failures within 15 minutes" is approximated: if
   `updatedAt` is more than 15 minutes old, the failure counter resets before incrementing. Good
   enough for phase 0; a real last-attempt column would be a one-line migration if this needs to
   be exact later.

6. **MFA is not enforced at login for `MFA_MANDATORY_ROLES` users who haven't enrolled yet.**
   Blocking login entirely would create a chicken-and-egg problem (`/auth/mfa/setup` itself
   requires being logged in). Login succeeds for these roles when `mfaEnabled=false`; the
   console is expected to nudge enrollment. No hard gate exists yet — a later phase could add a
   `mfaSetupRequired` flag/redirect if product wants a harder enforcement.

7. **A few files exist that weren't in the literal §4 file tree**, because the feature they
   support was specified elsewhere in the prompt but the file list omitted them:
   - `common/decorators/current-query-runner.decorator.ts` — required for the "every tenant-scoped
     query reuses the request's one stamped connection" invariant; there was no way to satisfy
     that without exposing the QueryRunner to controllers.
   - `common/interceptors/idempotency.interceptor.ts` — §6.7 fully describes this interceptor's
     behavior and `idempotent.decorator.ts` is in the file tree, but the interceptor file itself
     was never listed.
   - `auth/dto/mfa-code.dto.ts` — small DTO for `/auth/mfa/enable` and `/auth/mfa/disable`
     (`{ code }`), not called out separately from `verify-mfa.dto.ts` in §6.4.

8. **`/auth/me` returns `{ user, tenant }`, not a flat `UserDto`.** §7.1 requires the dashboard to
   show "current user, tenant name" — `AuthService.me()` now fetches the tenant alongside the
   user rather than making the web app do a second round trip. `CurrentUserResponseDto` in
   `packages/shared` reflects this (`tenant: Pick<TenantDto, "id"|"name"> | null`).

9. **`packages/shared` and `packages/db` compile to `dist/` and their `package.json` `main`/
   `types` point there**, not at `src/index.ts`. This wasn't specified either way, but it's
   required for correctness: a production `node dist/main.js` in `apps/api` cannot `require()` a
   `.ts` file directly. `turbo.json`'s `build`, `typecheck`, `lint`, and `dev` tasks all
   `dependsOn: ["^build"]` so this resolves correctly and transparently either way.

10. **`apps/worker` binds an HTTP health-check listener on `:4001`** even though it's a pure
    BullMQ consumer with no real HTTP API. Done solely so `pnpm dev` literally satisfies "worker
    on :4001" from the Definition of Done wording; the listener has no functional purpose beyond
    that.

## Known issues / incomplete items

- **No service-level unit tests** (`AuthService`, `UsersService`, `TenantsService`,
  `AuditService`, `MfaService`). Only `env.validation.spec.ts` exists as a real unit test; all
  other coverage is e2e-only. The e2e suite itself is now verified passing (see above), so this is
  a coverage gap (no fast, DB-less regression signal for service logic), not an unverified-behavior
  gap.
- **Next.js build warns**: "The Next.js plugin was not detected in your ESLint configuration."
  `eslint-config-next` was never added; lint passes on the shared generic TS preset but doesn't
  get Next-specific rules (image/link usage, hooks rules, etc.). Not blocking, just weaker
  coverage than a stock `create-next-app` project.
- **`ts-jest` prints a deprecation warning** about `isolatedModules` in the transform config
  instead of `tsconfig.json`. Cosmetic, non-blocking, never cleaned up.
- **GitHub Actions CI has never actually run.** No remote configured, nothing pushed. The
  workflow is written and matrix-structured (lint/typecheck/test/build as separate jobs, each
  reinstalling deps); its Postgres service container stays on port 5432 (GitHub Actions runners
  don't have the local port-5432 conflict described above), but "green on first push" is still
  unverified since nothing has been pushed to a remote.
- **Seed script's SUPER_ADMIN lives in an ad-hoc "RegOps Platform" tenant.** The schema requires
  every user to have a `tenant_id`, and the prompt doesn't specify what a platform-level admin's
  home tenant should be, so `seed.ts` creates one named `"RegOps Platform"` to hold it. This is a
  judgment call, not a spec requirement — revisit if product wants something else (e.g. a
  reserved sentinel tenant, or genuinely tenant-less super admins requiring a schema change).
- **Per-app `.env` files are not committed** (correctly gitignored) and must be created locally —
  `cp apps/api/.env.example apps/api/.env` etc. — before anything will run. A root-level `.env`
  also exists in this working copy with the same values consolidated into one file, but it is
  **not** read by any app at runtime (only referenced by `turbo.json`'s cache-invalidation
  `globalDependencies`); don't confuse the two if you see both.

## What a new session needs to know to continue safely

1. **There is one commit** (`Initial scaffold per Backend prompt 1`); everything since — including
   all the fixes in this handoff — is currently uncommitted working-tree changes (`git status`
   shows the modified/new files). Check `git status` before assuming a clean baseline.
2. **Bootstrap order matters**: `pnpm install` → copy the three `.env.example` files to `.env`
   (API needs `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET`, each 64+ chars and *different* from each
   other — `validateEnv` throws otherwise) → `docker-compose up -d` → `pnpm build` (compiles
   `packages/shared`/`packages/db` to `dist/`, which the apps `require()` at runtime) →
   `pnpm db:migrate` → `pnpm db:seed` → then `pnpm dev` works. **This exact sequence has now been
   run successfully end-to-end**, including a fresh `DROP SCHEMA public CASCADE` + re-migrate to
   confirm it works from a genuinely clean database, not just an already-warm one.
3. **If your host already runs a native PostgreSQL install, check for a port-5432 conflict**
   before assuming `docker-compose`'s Postgres is the one you're actually talking to — see bug #3
   above. Symptom is `password authentication failed for user regops_admin` even though the
   password is correct: `netstat -ano | grep :5432` (or `Get-NetTCPConnection -LocalPort 5432` in
   PowerShell) to check for a second listener. This repo's checked-in default is already remapped
   to host port 5433; only relevant if you change it back or hit a similar conflict on a different
   port.
4. **If you edit `packages/shared` or `packages/db` while `pnpm dev` is running**, the running
   apps won't see the change until you rebuild (`pnpm build --filter @regops/shared --filter
   @regops/db`) — there's no watch-mode build wired up for those two packages yet.
5. **Two Postgres roles matter and are easy to confuse**: the API always connects as
   `regops_app` (no `BYPASSRLS` — this is what makes RLS real); migrations and seeds connect as
   `regops_admin` (`BYPASSRLS`). If you ever see rows silently missing where you expect them,
   check which `DATABASE_URL`/`DATABASE_ADMIN_URL` a script is using before suspecting the RLS
   policy logic itself.
6. **Every tenant-scoped query in `apps/api` must go through the request's own `QueryRunner`**
   (`@CurrentQueryRunner()`), never a fresh injected repository from the connection pool — the
   pooled connection carries no `app.current_tenant_id` session var and RLS will silently return
   zero rows (or reject inserts). This is the single most important invariant in the codebase;
   read the doc comment on `TenantContextMiddleware` before adding any new tenant-scoped
   endpoint.
7. **Any new code path that opens its own `QueryRunner` and calls `set_config(..., true)`
   directly** (rather than going through `TenantContextMiddleware` or
   `AuthService.withBypassQueryRunner`) **must wrap it in `startTransaction()`/`commitTransaction()`
   /`rollbackTransaction()`.** This is exactly bug #5 above — `is_local = true` silently no-ops
   outside of a transaction, and the failure mode (RLS filters out rows instead of erroring) is
   easy to mistake for "no data yet" rather than a bug. If a `fn` passed to
   `withBypassQueryRunner` needs to signal an *expected* failure (bad credentials, locked account,
   etc.) without discarding writes already made in that same call (e.g. a failed-attempt audit
   row), return a tagged result instead of throwing — see `login()`/`verifyMfa()` for the pattern
   (bug #8 above); throwing there rolls back everything, including state you meant to keep.
8. **The transaction opened per-request is committed by `TransactionInterceptor`** (registered as
   the outermost `APP_INTERCEPTOR` in `app.module.ts`), not by the middleware that opens it. Commit
   must happen before Nest hands the response to Express — see bug #5 above for why a
   `res.on("finish")`-based commit is actively wrong (a client could see a success response for a
   write that never committed).

## Definition of Done — verified vs. not verified

| # | Item | Status |
|---|---|---|
| 1 | `git clone` → `pnpm install` → `docker-compose up -d` → `pnpm db:migrate` → `pnpm db:seed` works with zero manual steps | ✅ Verified — run against a freshly-dropped-and-recreated schema, not just an already-migrated one |
| 2 | `pnpm dev` starts api `:4000`, web `:3000`, worker `:4001` | ✅ Verified — ran `pnpm dev` (all three via turbo) concurrently; all three ports responded. Also caught and fixed a real cold-start race in `apps/api`'s dev script in the process (bug #10 above) |
| 3 | Seeded SUPER_ADMIN can log in via web UI and see the placeholder dashboard | ⚠️ Partial — verified at the API level (login → `/auth/me` → tenant/user returned correctly) via curl; not re-verified by driving an actual browser against the Next.js UI in this session |
| 4 | Seeded TENANT_ADMIN can log in, enable MFA, log out, log in again with MFA | ⚠️ Partial — non-MFA login/logout/refresh fully verified (e2e + manual curl); the MFA setup→enable→re-login-with-code loop is covered by `auth.e2e-spec.ts` (which now passes) but wasn't separately re-walked by hand |
| 5 | `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e` all pass | ✅ Verified — all four green, including all 18 e2e tests against the real docker-compose Postgres |
| 6 | All three integration test files present and passing | ✅ Verified — `auth`, `tenant-isolation`, and `audit` e2e specs all pass |
| 7 | GitHub Actions CI green on first push | ❌ Not verified — never pushed, no remote configured |
| 8 | Swagger docs at `/docs` reachable in development | ✅ Verified — `curl` returned 200 against the running app |
| 9 | README walks a new developer through setup in under 5 minutes | ✅ The exact documented command sequence was run start-to-finish this session and worked (port number updated to match the checked-in `docker-compose.yml`) |
| 10 | No secrets in committed code; `.env.example` covers every required env var | ✅ Verified by review — all three `.env.example` files checked against their app's `env.validation`/`process.env` reads |

**Bottom line**: the behavioral guarantees this phase exists to provide — RLS tenant isolation,
audit atomicity, auth flows including MFA and refresh-token rotation/theft-detection — are no
longer just written, they're passing against a real Postgres, and the full literal DoD path
(clone → install → up → migrate → seed → login → create tenant → create user → see audit logs)
has been walked end-to-end, with `pnpm dev` itself also verified running all three apps
concurrently. What's left is genuinely just: driving the actual browser UI by hand (as opposed to
the API directly), and pushing to a remote to get CI to run for real.
