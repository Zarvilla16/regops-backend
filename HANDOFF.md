# RegOps Phase 0 — Handoff

Written at the end of the initial scaffolding session. Read this before continuing work — it
covers what exists, what was deliberately changed from the Backend Prompt 1 spec (and why), what's
still unverified, and the exact steps a new session needs to get a working environment.

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

`pnpm lint`, `pnpm typecheck`, and `pnpm build` all pass clean across every package as of the end
of this session.

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

- **The three e2e suites have never actually run against a live Postgres/Redis.** This sandbox
  has no Docker. I confirmed the harness itself is structurally sound — booting the Nest app via
  `Test.createTestingModule` and letting TypeORM attempt a real connection hit an ambient local
  Postgres on this machine and failed cleanly with "password authentication failed for user
  regops_app" (i.e. it reached and exercised real connection code, just against the wrong
  server/role) — but **no assertion in `auth.e2e-spec.ts`, `tenant-isolation.e2e-spec.ts`, or
  `audit.e2e-spec.ts` has actually been exercised.** Treat these as "should work, unverified" until
  someone runs them against `docker-compose up`.
- **No service-level unit tests** (`AuthService`, `UsersService`, `TenantsService`,
  `AuditService`, `MfaService`). Only `env.validation.spec.ts` exists as a real unit test; all
  other coverage is e2e-only and therefore also unverified per the point above.
- **`docker-compose up` has never been run.** `docker/postgres-init/01-roles.sql` only executes
  on a **fresh** Postgres data volume (Postgres only runs `/docker-entrypoint-initdb.d` scripts
  when the data directory is empty). If a stale `regops_postgres_data` volume from an earlier,
  different attempt exists, the roles won't be (re)created and migrations will fail with a
  role/permission error — first troubleshooting step if that happens is
  `docker-compose down -v` and start clean.
- **Next.js build warns**: "The Next.js plugin was not detected in your ESLint configuration."
  `eslint-config-next` was never added; lint passes on the shared generic TS preset but doesn't
  get Next-specific rules (image/link usage, hooks rules, etc.). Not blocking, just weaker
  coverage than a stock `create-next-app` project.
- **`ts-jest` prints a deprecation warning** about `isolatedModules` in the transform config
  instead of `tsconfig.json`. Cosmetic, non-blocking, never cleaned up.
- **GitHub Actions CI has never actually run.** No remote configured, nothing pushed. The
  workflow is written and matrix-structured (lint/typecheck/test/build as separate jobs, each
  reinstalling deps) but "green on first push" is unverified by construction.
- **Nothing has been committed to git.** `git init` was run but every file is still untracked —
  don't assume any commit history exists.
- **Seed script's SUPER_ADMIN lives in an ad-hoc "RegOps Platform" tenant.** The schema requires
  every user to have a `tenant_id`, and the prompt doesn't specify what a platform-level admin's
  home tenant should be, so `seed.ts` creates one named `"RegOps Platform"` to hold it. This is a
  judgment call, not a spec requirement — revisit if product wants something else (e.g. a
  reserved sentinel tenant, or genuinely tenant-less super admins requiring a schema change).

## What a new session needs to know to continue safely

1. **Nothing is committed.** Check `git status` before assuming any baseline; the working tree
   *is* the only copy of this work right now.
2. **Bootstrap order matters**: `pnpm install` → copy the three `.env.example` files to `.env`
   (API needs `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET`, each 64+ chars and *different* from each
   other — `validateEnv` throws otherwise) → `docker-compose up -d` → `pnpm build` (compiles
   `packages/shared`/`packages/db` to `dist/`, which the apps `require()` at runtime) →
   `pnpm db:migrate` → `pnpm db:seed` → then `pnpm dev` works.
3. **If you edit `packages/shared` or `packages/db` while `pnpm dev` is running**, the running
   apps won't see the change until you rebuild (`pnpm build --filter @regops/shared --filter
   @regops/db`) — there's no watch-mode build wired up for those two packages yet.
4. **Two Postgres roles matter and are easy to confuse**: the API always connects as
   `regops_app` (no `BYPASSRLS` — this is what makes RLS real); migrations and seeds connect as
   `regops_admin` (`BYPASSRLS`). If you ever see rows silently missing where you expect them,
   check which `DATABASE_URL`/`DATABASE_ADMIN_URL` a script is using before suspecting the RLS
   policy logic itself.
5. **Every tenant-scoped query in `apps/api` must go through the request's own `QueryRunner`**
   (`@CurrentQueryRunner()`), never a fresh injected repository from the connection pool — the
   pooled connection carries no `app.current_tenant_id` session var and RLS will silently return
   zero rows (or reject inserts). This is the single most important invariant in the codebase;
   read the doc comment on `TenantContextMiddleware` before adding any new tenant-scoped
   endpoint.
6. **Before trusting anything in this handoff or in `README.md` as still-accurate**: this was
   all written in one sitting with no live DB/Docker to check assumptions against. Re-verify
   against the actual code before building Prompt 2 on top of it.

## Definition of Done — verified vs. not verified in this sandbox

| # | Item | Status |
|---|---|---|
| 1 | `git clone` → `pnpm install` → `docker-compose up -d` → `pnpm db:migrate` → `pnpm db:seed` works with zero manual steps | ❌ Not verified — no Docker here. `pnpm install` itself verified working. |
| 2 | `pnpm dev` starts api `:4000`, web `:3000`, worker `:4001` | ❌ Not verified — api/worker need a live DB to fully boot (TypeORM retries connecting before the app finishes bootstrapping) |
| 3 | Seeded SUPER_ADMIN can log in via web UI and see the placeholder dashboard | ❌ Not verified — requires live DB |
| 4 | Seeded TENANT_ADMIN can log in, enable MFA, log out, log in again with MFA | ❌ Not verified — requires live DB |
| 5 | `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e` all pass | ⚠️ Partial — `lint` ✅, `typecheck` ✅, `test` (unit) ✅, `test:e2e` ❌ (attempted; failed at DB auth against an ambient local Postgres instance, not the project's docker-compose Postgres — never actually exercised) |
| 6 | All three integration test files present and passing | ⚠️ Partial — all three files exist and are structurally complete; "passing" unverified (see #5) |
| 7 | GitHub Actions CI green on first push | ❌ Not verified — never pushed, no remote configured |
| 8 | Swagger docs at `/docs` reachable in development | ❌ Not verified — requires the app to fully boot against a live DB |
| 9 | README walks a new developer through setup in under 5 minutes | ✅ Written and internally consistent with the actual scripts/env vars; not literally timed with a fresh developer |
| 10 | No secrets in committed code; `.env.example` covers every required env var | ✅ Verified by review — all three `.env.example` files checked against their app's `env.validation`/`process.env` reads |

**Bottom line**: everything that can be checked *without* a running Postgres/Redis (dependency
graph, TypeScript types, lint rules, production build output, module resolution) has been
checked and is green. Everything that requires a live database — which is most of the actual
behavioral guarantees this phase exists to provide (RLS isolation, audit atomicity, auth flows)
— is written but **unverified**. Running `docker-compose up -d && pnpm db:migrate && pnpm db:seed
&& pnpm test:e2e` should be the first thing done in the next session with Docker available.
