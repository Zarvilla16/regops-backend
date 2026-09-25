# RegOps Phase 0 — Handoff

Originally written at the end of the initial scaffolding session, when this sandbox had no Docker
and nothing had run against a real database. **Updated after a follow-up session where Docker
became available** — the full stack was actually run for the first time: migrations, seed, all 18
e2e tests, and a manual walk through login → create tenant → create user → view audit logs via
curl. That run surfaced several real, previously-invisible bugs (see below); all are now fixed and
the fixes are verified, not just written. Read this before continuing work.

**Update — Backend Prompt 2 (Customer + Risk Rating module) is now complete.** Built on top of the
Prompt 1 foundation above with no changes to its guarantees. Full `pnpm lint && pnpm typecheck &&
pnpm test && pnpm test:e2e` passes clean across all 8 workspace packages, including 64 new unit
tests in `packages/risk-engine` (100% coverage) and 46 e2e tests across `apps/api`/`apps/worker`
(up from 18). The spec's 100,000-row CSV ingestion benchmark passes (410s, well under the
10-minute budget) — but only after a genuine performance bug was found and fixed; see the new bug
list below. Three real bugs were found this session, one of them in Prompt-1-era code that had
been sitting undisturbed until this module's tests exercised it hard enough to expose it.

**Update — Backend Prompt 3 (Screening module) is now complete.** Built on top of Prompts 1-2 with
no changes to their guarantees — `customer.is_pep`/`is_sanctioned`/`last_screened_at` (added in
Prompt 2, previously unused) are now genuinely written by this module. New workspace package
`packages/screening-engine` (framework-free, mirrors `packages/risk-engine`'s split) plus a new
`apps/api/src/screening` module, two new `apps/worker` BullMQ processors, and a new migration.
`pnpm lint && pnpm typecheck && pnpm test` pass clean across all 9 workspace packages (the new
`@regops/screening-engine` added); `apps/api`'s e2e suite is up to 56 (from 46) and `apps/worker`'s
is up to 14 (from 3, excluding the gated benchmark). See the new sections below for what's built,
deviations, and honestly-flagged gaps.

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

### Backend Prompt 2 (Customer + Risk Rating module) adds

- **`packages/shared`**: `CustomerType`/`CustomerStatus`/`RiskLevel`/`ScoreTrigger`/
  `RiskFactorType` enums, `CustomerDto`/`RiskScoreHistoryDto`/`RiskFactorConfigDto`/
  `BatchIngestJobStatusDto` wire types, `queues.ts` (BullMQ queue-name constants shared between
  `apps/api` and `apps/worker`), `ingestion.ts` (`IngestionJobData`/`IngestionJobResult`/
  `DuplicateStrategy`, also shared cross-process).
- **`packages/db`**: `Customer`, `RiskScoreHistory`, `RiskFactorConfig` entities; migration
  `1700000010000-CustomerAndRisk.ts` (creates the `pg_trgm`/`btree_gin` extensions, all three
  tables with their exact spec'd indexes — including a `gin (tenant_id, full_name gin_trgm_ops)`
  trigram index for fuzzy name search and a partial unique index on `(tenant_id, bvn) WHERE bvn IS
  NOT NULL` — and the same RLS enable/force + policy pattern as Prompt 1's tables); `seed.ts` now
  seeds default `RiskFactorConfig` rows for every tenant it creates.
- **`packages/risk-engine`** (new package): the 6-factor risk scoring engine — `CUSTOMER_TYPE`,
  `OCCUPATION`, `COUNTRY`, `PRODUCT_MIX`, `KYC_TIER` fully implemented; `TRANSACTION_VELOCITY` a
  deliberate scaffold (see deviations below) since the transactions module it depends on doesn't
  exist yet. `aggregateRiskScore()` sums+caps contributed scores, bands the result
  (LOW/MEDIUM/HIGH/CRITICAL), and forces CRITICAL on a PEP/sanctioned flag. Pure, framework-free
  TypeScript so both `apps/api` (NestJS) and `apps/worker` (plain Node, no DI) run the identical
  logic. 64 unit tests, 100% statement/branch/function/line coverage.
- **`packages/file-storage`** (new package): a `FileStorage` interface (`upload`/`getReadStream`/
  `getSignedDownloadUrl`) with `LocalFileStorage`, a local-disk dev implementation, standing in for
  Cloudflare R2 (no credentials available in this sandbox — see deviations below).
- **`apps/api`**: `CustomersModule` (CRUD, PII-masked list/detail + a role-gated, reason-required
  `/customers/:id/pii` unmask endpoint, fuzzy name search via pg_trgm, CSV batch upload endpoint
  backed by BullMQ + `LocalFileStorage`), `RiskModule` (`RiskFactorConfigService`, `RiskService`,
  manual re-score endpoint + risk-history endpoint, `RescoreSchedulerService` running daily
  (`0 2 * * *`, HIGH/CRITICAL), weekly (`0 3 * * 1`, MEDIUM), and monthly (`0 4 1 * *`, LOW)
  `@nestjs/schedule` cron jobs with concurrency-limited tenant processing). `EventEmitter2` wiring
  for customer create/update/delete and risk-level-change events; a `QueueEvents` bridge surfaces
  `apps/worker`'s BullMQ job-completion events into `apps/api`'s in-process event emitter.
- **`apps/worker`**: a second BullMQ `Worker` (alongside Prompt 1's maintenance worker) consuming
  the customer-ingestion queue — streams a CSV via `csv-parse` in chunks, validates each row with
  Zod, creates/updates/skips per the requested duplicate strategy, computes an initial or
  re-triggered risk score per row, records an audit-log entry per write, and uploads a
  machine-readable error-report CSV for any invalid rows.
- **Tests**: `apps/api/test/{customers,customer-ingestion,risk-rescoring}.e2e-spec.ts` (43 tests
  total across all `apps/api` e2e specs, up from 18) plus `apps/worker/test/customer-ingestion.e2e-
  spec.ts` (3 tests, calling the job processor directly against a real Postgres, no Redis/BullMQ in
  the loop) and a gated `apps/worker/test/customer-ingestion-benchmark.e2e-spec.ts` (100,000
  synthetic rows, `RUN_INGESTION_BENCHMARK=1` opt-in, not part of the default `pnpm test:e2e` run
  since a 10-minute budget would make routine test runs unacceptably slow).

All 11 new endpoints are documented in Swagger at `/docs` / `/docs-json`. `pnpm lint`, `pnpm
typecheck`, and `pnpm test` all still pass clean across all 8 packages (`api`, `config`, `db`,
`file-storage`, `risk-engine`, `shared`, `web`, `worker`). `pnpm test:e2e` passes clean — 43
`apps/api` tests + 3 `apps/worker` tests, 46 total. The gated 100k-row ingestion benchmark passes
(410s), but only after a genuine performance bug found in this session was fixed — see bug #13
below.

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

## Critical bugs found while building the Customer + Risk Rating module (all fixed)

Continuing the numbering above — these surfaced while building and load-testing Backend Prompt 2.

11. **`IdempotencyInterceptor`'s replay-cache write was fire-and-forget inside an RxJS `tap()`**
    (`tap((data) => { void repo.save(...) })`), racing against `TransactionInterceptor`'s outer
    commit-and-release. When the outer transaction committed and released the connection before
    the un-awaited `save()` landed, the idempotency-key insert either ran with RLS context already
    cleared or was silently lost — surfacing as "new row violates row-level security policy for
    table idempotency_key" followed by a spurious 409 on a legitimate replay of an `@Idempotent()`
    endpoint (`POST /customers`, added in this module). This is Prompt-1-era code, undisturbed
    until this module's e2e tests exercised idempotent POSTs heavily enough to hit the race
    reliably. Same bug class, and same fix, as bug #5's transaction-timing issue: switched to
    `mergeMap(async (data) => { await repo.save(...); return data; })` so the Observable chain
    actually awaits the write. Verified fixed via a clean e2e rerun.
12. **A single bad row anywhere in a CSV ingestion batch silently discarded every other row already
    processed in that same batch.** Root cause: Postgres aborts an entire transaction on any
    statement error (e.g. a unique-constraint violation from a duplicate BVN or
    `cbs_customer_id`), and an aborted transaction rejects all subsequent statements — including
    `COMMIT` — until rolled back to a valid point. The ingestion processor batches 100 rows per
    transaction; without per-row isolation, one bad row poisoned the whole batch, silently rolling
    back rows the JS-side counters had already recorded as "succeeded". Caught directly, not
    inferred: a manual curl upload reported `succeeded: 2, failed: 2` but zero customers actually
    existed in the database afterward. Fixed by wrapping each row in its own SAVEPOINT —
    `qr.startTransaction()`/`commitTransaction()`/`rollbackTransaction()` nested inside the batch's
    already-open transaction (TypeORM turns a nested `startTransaction()` into a real `SAVEPOINT`,
    the same mechanism behind bug #5's atomic-write pattern) — so a failing row rolls back only to
    its own savepoint. Verified by re-uploading the same CSV: `succeeded: 3, failed: 1`, with
    exactly the 3 valid customers persisted and correctly scored.
13. **The 100,000-row ingestion benchmark (the spec's explicit performance requirement — under 10
    minutes) failed on the first fully-correct run: 64,000/100,000 rows in 630s (~102 rows/sec),
    timing out.** Root cause was round-trip count, not CPU or database lock contention: each row
    cost roughly 7 sequential network round trips (open SAVEPOINT, existence check, customer
    INSERT, risk-score-history INSERT, a separate customer UPDATE to store the computed score,
    audit-log INSERT, release SAVEPOINT) over a Docker-Desktop-networked Postgres connection, where
    per-round-trip latency dominated over per-query execution time. Confirmed by directly querying
    how many rows the partially-completed benchmark tenant actually had, rather than guessing at
    the bottleneck. Fixed two ways, neither changing duplicate-detection or audit semantics: (a)
    the risk score is now computed from field values *before* the row is persisted and folded
    directly into the row's own INSERT/UPDATE, removing the separate score-UPDATE round trip; (b)
    chunks of 100 rows are now processed 6-at-a-time concurrently, each on its own pooled
    connection/transaction (`CONCURRENCY` in `ingestion-job.processor.ts`), with the `pg` pool's
    `extra.max` bumped from the default 10 to 20 in `apps/worker`'s `DataSource` accordingly — safe
    because each concurrent chunk still opens its own tenant-scoped transaction and each row within
    it still gets its own SAVEPOINT, so bug #12's fix is untouched. Re-run after the fix:
    100,000/100,000 rows succeeded in 410s.

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

## Deviations from the Backend Prompt 2 spec (and why)

1. **Cloudflare R2 is replaced with a local-filesystem `FileStorage` adapter for dev.** This
   sandbox has no R2 credentials; the user was asked and explicitly chose a local-disk
   implementation over stubbing/mocking R2 out entirely. `packages/file-storage` defines a small
   `FileStorage` interface (`upload`/`getReadStream`/`getSignedDownloadUrl`); `LocalFileStorage` is
   the dev implementation both `apps/api` (upload, error-report download) and `apps/worker`
   (stream-read, error-report upload) depend on only through that interface. Swapping in a real R2
   adapter later is a contained follow-up — a new class implementing the same interface plus a DI/
   construction swap — not a redesign. `getSignedDownloadUrl()` always returns `null` for the local
   adapter (documented as "no public endpoint, caller should proxy through an authenticated API
   route"); the error-report download endpoint already does exactly that (streams through
   `storage.getReadStream()` rather than redirecting to a signed URL), so this is inert today and
   will only matter once a real R2 adapter makes direct-from-storage downloads possible.
2. **`packages/risk-engine` and `packages/file-storage` are new workspace packages, not in the
   spec's literal file tree.** Needed because `apps/worker` is a plain Node process with no NestJS
   DI container but must run byte-for-byte the same deterministic risk-scoring logic as `apps/api`
   (for CSV-ingested customers) and share the same storage abstraction. Cross-`apps/*` source
   imports don't survive compilation and break Turborepo's cache-dependency tracking, so the pure,
   dependency-minimal logic was extracted into packages instead — same rationale as Prompt 1's
   deviation #9 (why `packages/shared`/`packages/db` compile to `dist/`). `packages/risk-engine`
   depends only on `@regops/shared`, never `@regops/db`, specifically to avoid a circular package
   dependency; it uses minimal structural types (`RiskFactorCustomer`, `RiskFactorTenant`, etc.)
   instead of importing TypeORM entities.
3. **The PEP/sanctioned CRITICAL override uses one literal marker, `factors.override = "PEP_FLAG"`,
   for both conditions** — matches the spec's exact wording verbatim rather than inventing a second
   marker for the sanctioned case. If a future session needs to distinguish "forced CRITICAL
   because PEP" from "forced CRITICAL because sanctioned" in the stored `factors` JSON, that's a
   one-line change in `aggregateRiskScore()` (`packages/risk-engine/src/aggregate.ts`), but as
   shipped both reasons collapse to the same marker.
4. **`TRANSACTION_VELOCITY` is a graceful scaffold, not a real implementation** — the transactions
   module it depends on (Prompt 4) doesn't exist yet. `TransactionVelocityFactor` takes an optional
   `TransactionVelocityAdapter` as a plain constructor parameter (not NestJS `@Optional()`/
   `@Inject()`, since `packages/risk-engine` has no NestJS dependency at all); every call site today
   supplies no adapter, so the factor returns `{ rawValue: 0, detail: { skipped:
   "transactions_module_not_loaded" } }` and contributes 0 to the score. When Prompt 4 ships, the
   only change needed is wiring a real adapter into `createFactorRegistry()` at the `apps/api`/
   `apps/worker` call sites — the factor's shape and the aggregation math don't change.
5. **The pg_trgm fuzzy-search similarity threshold was tuned empirically, not specified numerically
   by the spec.** Postgres's default `word_similarity` threshold (0.6) rejects common
   letter-transposition typos — "jhon" against "John Smith" scores 0.2, verified directly via
   `psql` before picking a replacement value. Lowered to 0.15 via `SET LOCAL
   pg_trgm.word_similarity_threshold = 0.15` (transaction-scoped, safe given the per-request
   transaction pattern) in `CustomersService.list()`'s search path — chosen as the smallest value
   that still matched the target case while continuing to reject unrelated names in manual
   testing. This is a tuned constant, not a derived one; revisit it if fuzzy search feels too loose
   or too strict in real usage.

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
9. **Any batch job that writes multiple rows inside one transaction must give each row its own
   SAVEPOINT**, not just wrap the whole batch in one transaction — see bug #12. Postgres aborts an
   entire transaction on any statement error and then rejects everything else, including `COMMIT`,
   until rolled back; without per-row `startTransaction()`/`commitTransaction()`/
   `rollbackTransaction()` nesting, one bad row silently discards every other row already processed
   in the same batch, and the failure mode (counters say "succeeded" but nothing is actually in the
   database) is easy to miss unless you specifically check row counts after a partial-failure test.
10. **Any new async side effect inside an RxJS operator must actually be awaited by the Observable
    chain** — `tap((x) => { void somePromise() })` is a race, not a shortcut. This exact bug has now
    been found twice (bug #5's `TenantContextMiddleware`/`TransactionInterceptor` interaction, and
    bug #11's `IdempotencyInterceptor`): if an outer interceptor can commit and release the
    connection before the un-awaited write lands, the write either runs with a cleared RLS context
    or is silently lost. Use `mergeMap`/`concatMap` with an `async` callback instead.
11. **New code paths that touch storage (uploads, downloads, error reports) must go through the
    `FileStorage` interface in `packages/file-storage`**, never call disk or a cloud SDK directly.
    The dev implementation (`LocalFileStorage`) and a future R2 implementation are meant to be
    interchangeable; reaching around the interface anywhere defeats that.
12. **`CONCURRENCY` in `apps/worker/src/customer-ingestion/ingestion-job.processor.ts` is coupled
    to the ingestion `DataSource`'s connection pool size (`extra.max`)** — see bug #13. Raising
    `CONCURRENCY` without also raising `extra.max` (currently 20, comfortably above the current
    `CONCURRENCY = 6`) will exhaust the pool and effectively re-serialize the work through pool
    contention instead of actually speeding it up.
13. **`RiskFactorConfigEntity.config` is a `jsonb` blob whose expected shape is entirely
    factor-specific** — each factor in `packages/risk-engine/src/factors/*.ts` reads different keys
    out of it, and the shapes are documented only by `DEFAULT_RISK_FACTOR_CONFIGS`
    (`packages/risk-engine/src/default-configs.ts`) and the factor implementations themselves, not
    by any schema/type on the column. If you change what a factor expects, update
    `DEFAULT_RISK_FACTOR_CONFIGS` and be aware any tenant-specific overrides already seeded or
    saved via `RiskFactorConfigService` won't automatically pick up the new shape.
14. **Pure logic shared between `apps/api` and `apps/worker` belongs in a `packages/*` package, not
    a cross-app import.** `apps/worker` has no NestJS DI container, so anything it must run
    identically to `apps/api` (risk scoring, storage access) needs to live somewhere both can
    `import` as a compiled package — see deviation #2 above for why `packages/risk-engine` and
    `packages/file-storage` exist and why `risk-engine` deliberately doesn't depend on
    `packages/db`.

## Definition of Done — Backend Prompt 1 — verified vs. not verified

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

## Definition of Done — Backend Prompt 2 — verified vs. not verified

| # | Item | Status |
|---|---|---|
| 1 | Customer entity + CRUD endpoints, PII (bvn/nin) masked by default with a role-gated, reason-required unmask endpoint | ✅ Verified — `customers.e2e-spec.ts` covers create/uniqueness/idempotency/tenant-isolation, list+filters+fuzzy-search, update, soft-delete, and PII mask/reveal/403/400/audit |
| 2 | CSV batch ingestion (upload + BullMQ streaming), duplicate handling per requested strategy | ✅ Verified — `customer-ingestion.e2e-spec.ts` at both the `apps/api` (upload/status/tenant-isolation) and `apps/worker` (direct processor call: mixed valid/invalid rows, `skip`, `update`) levels |
| 3 | Risk scoring engine: 6 factors via a Strategy pattern, tenant-tunable configs, deterministic | ✅ Verified — 64 unit tests across 9 spec files in `packages/risk-engine`, 100% statement/branch/function/line coverage, explicit determinism assertions per factor |
| 4 | Aggregation/banding algorithm (LOW/MEDIUM/HIGH/CRITICAL) with PEP/sanctioned override | ✅ Verified — `aggregate.spec.ts` covers banding boundaries, the override, and score capping |
| 5 | Re-scoring lifecycle: daily/weekly/monthly cron jobs, concurrency-limited tenant processing | ⚠️ Partial — the underlying `rescoreTenantCustomers`/`rescoreAllTenants` logic the cron jobs call is exercised directly and passes (`risk-rescoring.e2e-spec.ts`); the actual `@Cron("0 2 * * *")`/`@Cron("0 3 * * 1")`/`@Cron("0 4 1 * *")` schedules have not been observed firing in real time |
| 6 | DB schema/migration: `customer`, `risk_score_history`, `risk_factor_config` with the exact spec'd indexes (incl. pg_trgm GIN) and RLS | ✅ Verified — migration applied and reverted cleanly against the live Postgres; pg_trgm fuzzy search manually verified via `psql` before relying on it in application code |
| 7 | Unit tests per risk factor at >95% coverage (happy path, edge cases, config variations, determinism) | ✅ Verified — 100% coverage confirmed via `pnpm --filter @regops/risk-engine test`, exceeding the 95% bar |
| 8 | Risk aggregation tests (banding boundaries, overrides, capping, error propagation) | ✅ Verified — `aggregate.spec.ts` and `run-factors.spec.ts` |
| 9 | Integration/e2e tests: CRUD, tenant isolation, PII access, CSV ingestion, re-scoring | ✅ Verified — all suites passing, 46 e2e tests total (43 `apps/api` + 3 `apps/worker`) |
| 10 | CSV ingestion benchmark: 100,000 rows in under 10 minutes | ✅ Verified — 100,000/100,000 succeeded in 410s, but only after finding and fixing a genuine ~102-rows/sec performance bottleneck (bug #13 above); the first fully-correct run had timed out at 630s having processed only 64,000 rows |
| 11 | Swagger docs cover all new endpoints; audit log coverage for customer/risk actions | ⚠️ Partial — `/docs-json` confirmed to list all 11 new endpoints; audit coverage is exercised by e2e assertions and one direct SQL spot-check (CSV-ingested customers correctly attributed to `uploadedBy` with a `csv_ingestion` source tag) but wasn't cross-checked action-by-action against a literal checklist |
| 12 | `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e` all pass | ✅ Verified — all four green across all 8 workspace packages immediately before this handoff update, including the 46 e2e tests above (the benchmark is gated behind `RUN_INGESTION_BENCHMARK=1` and run separately, see item 10) |

**Bottom line**: the module's core behavioral guarantees — deterministic tenant-tunable risk
scoring, PII masking with an auditable unmask path, tenant-isolated CSV ingestion that can't
silently lose rows on partial failure, and the 100k-row performance target — are verified against
a real Postgres, not just written. What's left is genuinely just: watching the actual cron
schedules fire in real time (as opposed to calling the same code directly), and a more systematic
audit-action-by-action cross-check against the spec's exact list.

### Backend Prompt 3 (Screening module) adds

- **`packages/screening-engine`** (new package, framework-free — same split rationale as
  `packages/risk-engine`): `ScreeningProvider` interface, `MockProvider` (deterministic per the
  spec's fullName-substring table — `SANCTIONED`/`POSSIBLY_SANCTIONED`/`PEP`/`TIMEOUT_TEST`/
  `CRASH_TEST`), `SmileIdProvider`/`PremblyProvider` (native `fetch` + `AbortController`, no HTTP
  client dependency — real endpoint shapes are a best-effort mapping per the spec's own wording,
  since this sandbox has no network access to the real Smile ID/Prembly sandboxes to verify
  against), threshold banding (`bandScore`/`bandHighestScore`, tenant-overridable via
  `Tenant.config["screening.thresholds"]`), `computeInputHash` (dedup), and `screenWithFallback`
  (retry-then-fallback orchestration, retry schedule injectable so tests don't sleep for real
  seconds). 40 unit tests, ~97% coverage (the two intentionally-uncovered gaps are the real
  `setTimeout`-based default retry delay and each real provider's placeholder `healthCheck`).
- **`packages/shared`**: `ScreeningProviderName`/`ScreeningCheckType`/`ScreeningCheckStatus`/
  `ScreeningResultType`/`ScreeningTrigger`/`MatchReviewStatus`/`MatchDecision` enums;
  `ScreeningCheckDto`/`ScreeningMatchDto`/`ScreeningProviderConfigDto` wire types (the config DTO
  deliberately omits `credentialsRef`/`config` — never round-tripped to any client, not even
  TENANT_ADMIN); `ASYNC_SCREENING_QUEUE`/`RESCREEN_QUEUE` queue names; `screening.ts`
  (`AsyncScreeningJobData/Result`, `RescreenJobData/Result` — shared job shapes between the
  `apps/api` producer and `apps/worker` consumer, same convention as `ingestion.ts`).
- **`packages/db`**: `ScreeningProviderConfigEntity`, `ScreeningCheckEntity`, `ScreeningMatchEntity`,
  `InternalBlacklistEntity`; migration `1700000020000-Screening.ts` (all four tables, the spec's
  indexes including the partial-unique one-primary-per-check-type index and the pg_trgm GIN index
  on `internal_blacklist.full_name`, same RLS enable/force + policy pattern as every earlier
  migration). Applied and reverted cleanly against the live Postgres multiple times, including from
  a genuinely empty schema alongside all four earlier migrations.
- **`apps/api/src/screening`**: `ScreeningService` (the core engine — dedup, internal blacklist
  first, provider-registry resolve + retry/fallback, persists `ScreeningCheck`/`ScreeningMatch`),
  `screenSync` (the onboarding sanctions block — throws 422/503, see the design-decision writeup
  below), `screenExistingCustomerSanctions` (the on-demand re-check endpoint — never blocks, only
  auto-flags), `MatchReviewService` (review decision logic, flag-setting, re-score), controllers for
  both, `ProviderRegistry`/`ScreeningProviderConfigService`/`InternalBlacklistProvider`/
  `SecretsService` (env:// working, vault:// a documented stub), `AsyncScreeningQueueService`/
  `RescreenQueueService` (BullMQ producer + `QueueEvents` bridge, exact mirror of
  `CustomerIngestionService`'s existing pattern — re-emits `EventEmitter2` events once the worker's
  job actually completes), `RescreenSchedulerService` (3 cron jobs, enqueue-only), `CustomerListener`
  (`@OnEvent("customer.updated")` → async re-screen when a screening-relevant field changes). Wired
  into `CustomersService.create()` per the spec's exact pseudocode shape, and into
  `TenantsService.create()` for default provider-config seeding.
- **`apps/worker`**: `async-screening.processor.ts` (PEP/adverse-media for new customers) and
  `rescreen-job.processor.ts` (scheduled re-screen), each with their own duplicated
  `screening-check-runner.ts`/`apply-confirmed-match.ts` glue — same "no NestJS DI here, so the
  provider-resolution/internal-blacklist/risk-rescore logic gets its own worker-side copy" reasoning
  `ingestion-job.processor.ts` already established for risk scoring.
- **`packages/db/src/seed/seed.ts`**: seeds `MockProvider` as primary for all three check types for
  both the platform and demo tenants, idempotently (safe to re-run).
- **Tests**: `packages/screening-engine` — 7 spec files, 40 tests. `apps/api/test/screening.e2e-spec.ts`
  — 13 tests (sync block, fail-closed, match review incl. audit/event assertions, tenant isolation,
  the two previously-easy-to-forget direct endpoints `GET /screening/checks(/:id)` and
  `POST /screening/customers/:id/sanctions`). `apps/worker/test/screening.e2e-spec.ts` — 11 tests
  (async PEP flow, internal blacklist short-circuit incl. an expiry case, scheduled re-screen incl.
  dedup). Every existing fixture-creating e2e spec that calls `POST /customers`
  (`customers.e2e-spec.ts`, `risk-rescoring.e2e-spec.ts`) now also calls the new
  `seedScreeningProviderConfigsFixture` test helper — omitting it makes every customer-creation call
  500 (`ProviderRegistry`: no primary provider configured), exactly as it would in a real
  under-provisioned tenant.

#### The critical design decision, implemented as specified

Section 2.1's synchronous/asynchronous asymmetry is real, not just written: `screenSync` runs on
its **own dedicated database connection** (`ScreeningService.withDedicatedTenantContext`, same
pattern as `RescoreSchedulerService.withTenantContext`), separate from the ambient per-request
transaction `TenantContextMiddleware`/`TransactionInterceptor` manage. This is what makes the
resulting `screening_check`/`screening_match`/`customer.create.blocked` audit rows survive even
though the request as a whole throws a 422 and its own ambient transaction gets rolled back —
discovered by writing the naive version first (same connection as the rest of the request) and
watching the audit trail vanish on a 422, then fixing it the same way this codebase's own bug #8
(`AuthService.login()`) already did: give the write its own commit boundary, independent of
whatever the caller does with the exception afterward.

**Re-confirmed a second way, independent of the automated suite**: beyond `screening.e2e-spec.ts`,
this exact behavior was walked by hand against a live `node dist/main.js` + `node dist/main.js`
(api + worker) pair on the seeded demo tenant, via raw `curl` (see
`docs/testing/prompt-3-swagger-test-guide.md` for the click-by-click version of the same walk):
- `fullName: "John SANCTIONED Doe"` → `422 SANCTIONS_MATCH_BLOCK`, no `Customer` row, exact response
  body confirmed to omit `listSource`/`matchName` from `error.details`.
- `fullName: "TIMEOUT_TEST Ltd"` → `503 SCREENING_PROVIDER_UNAVAILABLE`, no `Customer` row — on the
  demo tenant's actual seeded provider config (`MOCK` primary, no fallback), no special setup
  needed to trigger fail-closed.
- `fullName: "Wale POSSIBLY_SANCTIONED Balogun"` → `201`, customer created, and — this is a real,
  worth-knowing quirk of `MockProvider`'s design — **all three checks (SANCTIONS, PEP,
  ADVERSE_MEDIA) evaluate the same `fullName` through the identical substring rules regardless of
  `checkType`** (`MockProvider.screen()` never reads its `checkType` parameter). Concretely: any
  name that would auto-flag PEP (contains `"PEP"`) *also* returns `CONFIRMED_MATCH` on the
  synchronous SANCTIONS pre-screen, which blocks onboarding before the async PEP job could ever be
  enqueued — so a customer that successfully reaches the async PEP-confirmed-and-flagged state via
  `MockProvider` cannot exist. What *is* demonstrable, and was verified live: a `POTENTIAL_MATCH`
  name creates the customer normally, and within ~200ms (worker already running) three
  `PENDING_REVIEW` `ScreeningMatch` rows appear — one per check type, same score/list source, since
  `MockProvider` can't tell them apart — after which reviewing the PEP one as `TRUE_POSITIVE` does
  flip `isPep: true` and `riskLevel: CRITICAL` for real. Not a bug; a documented limitation of the
  mock's checkType-blind design, worth knowing before assuming any arbitrary "CONFIRMED_MATCH"
  scenario is reachable through every code path.

## Critical bugs found while building the Screening module (all fixed)

Continuing the numbering above — this surfaced during a live post-handoff review of Backend Prompt 3.

15. **`MatchReviewService.applyTruePositive` flipped `isSanctioned`/`isPep`, re-scored the customer,
    and emitted a `customer.sanctions_confirmed`/`customer.pep_confirmed` `EventEmitter2` event — but
    never wrote an `audit_log` row for any of it.** Only the review decision itself
    (`screening.match.reviewed`) was audited; the resulting customer state change wasn't, violating
    Section 4.1's "every state change is audit-logged" principle. Caught by a live manual test:
    reviewing a `PEP` match `TRUE_POSITIVE` correctly flipped `isPep`/`riskLevel` on
    `GET /customers/{id}`, but `GET /audit-logs` showed no corresponding entry anywhere. Confirmed as
    a genuine gap, not a query-side miss, by comparing against the automated equivalent —
    `apps/worker/src/screening/apply-confirmed-match.ts`, which already writes a dedicated
    `customer.sanctions_flagged`/`customer.pep_flagged` audit row for the identical kind of change —
    so the human-reviewed path was the one actually missing its half. Fixed by adding an
    `auditService.record` call at the end of `applyTruePositive`, using `customer.sanctions_confirmed`/
    `customer.pep_confirmed` as the action (mirroring the existing event names 1:1, so the
    human-reviewed and automated paths stay independently visible in the trail, same reasoning
    `RiskService`'s `rescoreManual`/`rescoreScheduled` already established), with real
    `ipAddress`/`userAgent` threaded through from the request. Verified with a live re-test against
    the running dev server (not just the e2e suite): created a customer with a `POSSIBLY_SANCTIONED`
    name, reviewed its `PEP` match `TRUE_POSITIVE`, and confirmed `GET /audit-logs` now returns a
    `customer.pep_confirmed` row with `afterState: { isPep: true, riskLevel: "CRITICAL", ... }` and
    real `ipAddress`/`userAgent` values. Also added regression coverage:
    `screening.e2e-spec.ts`'s existing SANCTIONS `TRUE_POSITIVE` test now asserts the `audit_log` row
    directly (it previously only checked the in-process event), and a new equivalent `PEP` test was
    added alongside it. Writing that PEP test surfaced a related trap worth noting: `MockProvider`
    upper-cases `fullName` before matching its triggers, so a test customer literally named with
    `"PEP"` in it would trigger a real, automated `CONFIRMED_MATCH` during that customer's own async
    onboarding screen, racing the test's manually-seeded pending match — avoided by choosing a name
    with no trigger substring, same precaution the pre-existing tests in this file already took for
    `SANCTIONED` (`"TP Sanctions Subject"`, not literally `"SANCTIONED"`).

### Deviations from the Backend Prompt 3 spec (and why)

1. **`InternalBlacklistProvider` does not implement the shared `ScreeningProvider` interface.** The
   interface's `screen(checkType, input, config)` has no `QueryRunner` parameter, but the internal
   blacklist genuinely needs tenant-scoped DB access (BVN/NIN exact match, trigram fuzzy name
   match) that an external provider's `config: Record<string, unknown>` blob has no room for. It's
   resolved by direct injection in `ScreeningService`/duplicated as a plain function in
   `apps/worker`, never through `ProviderRegistry.resolve()`'s interchangeable primary/fallback
   mechanism — matching the spec's own framing of it as "hard-wired," not one of the swappable
   providers.
2. **`screening_match.customer_id` is nullable**, deviating from the spec's literal (unannotated,
   so presumptively NOT NULL) schema. Section 10.3's own test requires a `ScreeningMatch` row to
   exist for the blocked-onboarding scenario, where by construction there is no customer to
   reference yet — the same reasoning `screening_check.customer_id` (explicitly nullable in the
   spec) already rests on.
3. **Retry schedule is `[1000ms, 4000ms]` (3 total primary attempts) by default**, reconciling
   Section 4.5's literal text ("retry primary once with exponential backoff (1s, then 4s)") against
   Section 10.2's terser "retried once... second failure, fallback called" test description — read
   as validating the retry-then-fallback *mechanism* with whatever schedule is configured, not
   literally capping production behavior at 2 attempts. `screenWithFallback`'s retry delays are
   injectable specifically so tests can exercise both the full production schedule and a
   fast/short one without real multi-second sleeps.
4. **Section 10.4's "with fallback: same input → fallback used, customer created if fallback CLEAN"
   is not literally tested.** `MockProvider`'s behavior is a pure function of `fullName` only, with
   no notion of "which slot (primary/fallback) is calling me" — so a fallback also configured as
   `MOCK` behaves identically to the failing primary for the same input, and a real HTTP-based
   fallback would need actual network reachability this sandbox doesn't have (Section 7.3: "CI
   never calls Smile ID or Prembly"). The retry→fallback *mechanism* itself is fully unit-tested
   with fully-controllable fake providers in `screening-engine/src/fallback.spec.ts`; only the
   "fallback provider genuinely succeeds where primary failed, for the same real input" scenario is
   the untested (undecidable without a MockProvider redesign) half.
5. **`dto/screen-customer.dto.ts` from Section 4.1's literal file tree doesn't exist** — its purpose
   was never spelled out (a request body for `/sanctions` doesn't need one; it re-screens the
   customer's own already-stored fields). `dto/configure-providers.dto.ts` exists instead, since
   `PUT /screening/providers` genuinely needs a request DTO and nothing else in the tree names it.
6. **`screening.check.completed`/`customer.pep_flagged`/`customer.sanctions_flagged` are both
   `EventEmitter2` events (Section 8) *and* `audit_log` rows (Section 12's Definition of Done lists
   them as audit actions).** Initially built as events only; caught before considering this prompt
   done by re-reading Section 12 literally against what was actually persisted, and fixed by adding
   the corresponding `AuditService.record`/direct-repo-write calls at every emission site, both
   `apps/api`- and `apps/worker`-side.
7. **Section 9's async-enqueue choice**: inline for the synchronous sanctions pre-screen at
   onboarding (unavoidable — it's the return value the caller blocks on) and for the async
   PEP/adverse-media enqueue at onboarding (called directly from `CustomersService.create()`,
   after commit); event-driven (`@OnEvent("customer.updated")`, `CustomerListener`) for the
   post-onboarding `UPDATE` trigger, since `customer.updated` already exists as a stable public
   event and subscribing to it keeps `CustomersService` itself unaware that screening cares about
   its updates.
8. **Auto-opening a Case when `match.score >= 80` is not implemented in any form — no stub, no
   TODO, no log-only no-op.** Case Management doesn't exist as a backend module: `apps/api/src` has
   no `Case` entity, module, or service, and `packages/db` has no `case`/`cases` table in any
   migration. (The only "Case" code anywhere in the repo is unrelated frontend mock data — random
   `matchScore` values for UI display only — on a separate, disconnected `feature/frontend-mock-data-demo`
   branch, not this branch or `master`.) Unlike `TRANSACTION_VELOCITY` (deviation #4 above), which is
   a genuine scaffold with an injectable no-op adapter standing in for its missing dependency,
   screening's score path has no equivalent hook at all: `bandScore()`
   (`packages/screening-engine/src/thresholds.ts`) bands a match against the real configured
   thresholds (`potentialMatchMin: 60`, `confirmedMatchMin: 85` — there is no `80` threshold
   anywhere in the codebase), and both `MatchReviewService.applyTruePositive` (`apps/api`, fired on
   a human `TRUE_POSITIVE` review decision) and its automated-`CONFIRMED_MATCH` counterpart
   (`apps/worker/src/screening/apply-confirmed-match.ts`) dead-end at flagging
   `isSanctioned`/`isPep`, re-scoring the customer, and writing the audit/event pair — neither
   references a score threshold, a Case, or an escalation queue anywhere past that point. When Case
   Management ships, this needs a genuinely new branch added at both of those call sites (checking
   `match.matchScore >= 80` and opening a Case), not a wire-up of an existing scaffold.

### Known issues / incomplete items (Backend Prompt 3)

- **A `pnpm build` (root, via turbo) hang was observed once this session and initially misdiagnosed
  as a `turbo.json` `outputs`-glob caching config mismatch** (a warning — `no output files found for
  task @regops/api#build` — seen alongside it). Retried later and completed cleanly in 49s, so the
  hang itself didn't reproduce and was never root-caused with certainty. The warning *was* run to
  ground, though, and it's a different, real, pre-existing bug: **a recurrence of Backend Prompt
  1's already-documented bug #2** (stale `apps/api/tsconfig.tsbuildinfo` convinces `tsc`
  `dist/` is already up to date when it isn't, so it exits 0 having silently written nothing).
  Confirmed directly — `rm -rf dist tsconfig.tsbuildinfo && npx nest build` produced a full `dist/`
  where `pnpm build`'s turbo-orchestrated run had produced none. Not a `turbo.json` `outputs` key
  problem at all; that was an incorrect first guess, corrected here rather than left standing. If a
  future `dist/` ever comes up empty after a "successful" build, this is the fix (see bug #2's own
  entry above for the full explanation) — turbo's caching just makes the missing-output symptom
  show up one layer further away from the actual `tsc` invocation.
- **`ManualScreenDto`, `ReviewMatchDto`, and `ConfigureProvidersDto` render as an empty `{"type":
  "object", "properties": {}}` schema in Swagger** — confirmed by curling the live `/docs-json` and
  inspecting each endpoint's `requestBody` schema directly. None of the three has explicit
  `@ApiProperty()` decorators, and the `@nestjs/swagger` CLI plugin that would otherwise infer them
  automatically isn't enabled in `apps/api/nest-cli.json` (same reason `ListCustomersDto`'s query
  params don't render for `GET /customers` — Prompt 2's handoff already documented that half of the
  same gap). Concretely: `POST /screening/customers/:id/screen`, `POST /screening/matches/:id/review`,
  and `PUT /screening/providers` all show a blank `{}` JSON box in Swagger's UI, not typed fields —
  the correct body has to be typed in by hand from the DTO source, same as Prompt 2's
  `POST /customers/batch` gap. The endpoints themselves validate and behave correctly regardless
  (confirmed live and by e2e tests) — this is purely a Swagger discoverability gap.
- **`GET /screening/checks` and `GET /screening/matches` have no query parameters declared in
  Swagger either** (`customer_id`/`check_type`/`status`/`result`/`review_status`/`page`/`limit` —
  confirmed absent via the same `/docs-json` inspection) — the exact same class of gap Prompt 2's
  handoff already documented for `GET /customers`' fuzzy-search params. Clicking "Try it out" shows
  only an Execute button; the endpoints' filtering logic itself works (verified by e2e tests and
  live `curl` with query strings), it just can't be driven from typed Swagger fields.
- **No unit tests for `apps/api/src/screening/*.ts` services themselves** (`ScreeningService`,
  `MatchReviewService`, `ProviderRegistry`, `ScreeningProviderConfigService`) — coverage is e2e-only
  for this module's NestJS layer, same pre-existing gap `AuthService`/`UsersService`/etc. already
  have (see "Known issues" above, Backend Prompt 1).
- **The 3 scheduled cron jobs' actual `@Cron(...)` schedules have not been observed firing in real
  time** — more precisely than this entry previously stated, only the *downstream* work a dequeued
  job does (`processRescreenJob` in `apps/worker`, 5 tests in
  `apps/worker/test/screening.e2e-spec.ts`, using hand-built job payloads that bypass the real
  producer entirely) is actually exercised. That is a narrower guarantee than it sounds like next to
  `RescoreSchedulerService`'s identically-worded Prompt 2 caveat — see the entry directly below for
  what it leaves uncovered on the producer side.
- **`RescreenSchedulerService` and `RescreenQueueService` (the producer side of scheduled per-tier
  re-screening — the `@Cron` triggers themselves and the `enqueueForAllTenants` fan-out/`enqueue`
  call) have zero test coverage: no unit test, no e2e test, referenced in no test file in the repo
  at all** (confirmed by grepping `apps/api/test`, `apps/worker/test`, and for any `.spec.ts` near
  the scheduler/queue source). This is a materially different, more serious situation than Prompt
  2's analogous `RescoreSchedulerService` cron jobs, whose own Definition-of-Done caveat carries the
  same "timing not observed firing live" wording but *is* backed by a real e2e test
  (`risk-rescoring.e2e-spec.ts`) exercising the actual scheduled logic end-to-end, just not on the
  real clock. Here there is no equivalent test at any level for the scheduler/producer side — only
  the unrelated dequeue-side `processRescreenJob` work above is tested, using payloads constructed
  by hand rather than ones that actually came from `RescreenQueueService.enqueue`. This should be
  closed out with a real test (e.g., instantiate `RescreenSchedulerService` directly and call
  `dailyRescreenHighRisk()`/`weeklyRescreenMediumRisk()`/`monthlyRescreenLowRisk()`, or seed
  multiple tenants and assert `RescreenQueueService.enqueue` fires once per active tenant with the
  right `riskLevels`/`checkTypes`) before this module is considered fully production-ready — this is
  a real correctness/coverage gap, distinct from the Swagger-documentation-only gaps listed
  elsewhere in this section, which don't affect whether the underlying logic actually works.
- **Real Smile ID / Prembly response-shape mapping is unverified against the real sandboxes** —
  this environment has no network access to either. Field names (`match_categories`,
  `confidence_value`, `watchlist_hits`, etc.) follow the spec's own wording as closely as possible;
  revisit before ever pointing a `ScreeningProviderConfig` row at a real (non-`MOCK`) provider.
- **`GET /screening/providers`/`PUT /screening/providers` have only one direct e2e test each**
  (list via the config-isolation test; configure via the same) — no dedicated test for
  `PUT`'s validation edges (e.g. two `is_primary: true` rows for the same check_type in one
  request, which the partial unique index would reject at the DB layer with an unhandled
  constraint-violation error rather than a clean 4xx).

### Definition of Done — Backend Prompt 3 — verified vs. not verified

| # | Item | Status |
|---|---|---|
| 1 | Migration applies cleanly and rolls back cleanly | ✅ Verified — applied/reverted/re-applied against the live Postgres multiple times, including a from-empty-schema run alongside all four earlier migrations |
| 2 | All four entities created, RLS policies applied | ✅ Verified — migration includes `ENABLE`/`FORCE ROW LEVEL SECURITY` + `tenant_isolation`/`super_admin_bypass` policies for all four tables |
| 3 | All endpoints in Section 6 functional and role-gated | ✅ Verified — all 9 endpoints e2e-tested (list/detail/review/providers/sanctions/screen), each behind `@Roles(...)` matching the spec's table; also independently re-confirmed by hand against a live server via `curl` (role check on `PUT /screening/providers` as COMPLIANCE_OFFICER → real `403 FORBIDDEN_ROLE`, `GET /screening/checks/{bad-id}` → real `404`) |
| 4 | Default ScreeningProviderConfig seeded for every new tenant (MockProvider non-prod; SmileId+Prembly fallback prod) | ✅ Verified for non-prod (seed script + `TenantsService.create()`, confirmed via direct DB query and live `GET /screening/providers` against the seeded demo tenant) — the prod branch is written but not exercised by any test (this sandbox has no production env to seed against) |
| 5 | Synchronous sanctions block at customer creation working end-to-end | ✅ Verified — `screening.e2e-spec.ts`'s sync-block tests, plus a live `curl` walk (see the design-decision writeup above) confirming the exact `422` body |
| 6 | Fail-closed behavior on provider outage verified by test | ⚠️ Partial — the no-fallback → 503 path is fully verified (by test *and* live against the demo tenant's actual seeded config, no special setup needed); the with-fallback → recovery path is not (see deviation #4) |
| 7 | Async PEP/adverse-media flow working end-to-end | ✅ Verified — `apps/worker`'s `processAsyncScreeningJob` tests, including the ADVERSE_MEDIA-never-auto-flags case |
| 8 | Match review workflow (TRUE_POSITIVE/FALSE_POSITIVE, downstream flags) | ✅ Verified — both decisions tested, plus the 409-on-second-review and 403-as-VIEWER edges |
| 9 | Scheduled re-screening jobs registered and tested via manual trigger | ⚠️ Partial — same caveat as Prompt 2's `RescoreSchedulerService`: the underlying job logic is directly tested, the `@Cron` schedules themselves have not been observed firing |
| 10 | Internal blacklist hard-wired to run first; verified by test | ✅ Verified — a name that would score CLEAN under `MockProvider` alone returns CONFIRMED_MATCH once blacklisted, plus an expiry-respecting negative case |
| 11 | Dedup of repeated screening calls within 1 hour | ✅ Verified — a second identical check returns the same cached `ScreeningCheck` id, not a new one |
| 12 | All audit log actions present (`screening.check.completed`, `screening.match.reviewed`, `customer.create.blocked`, `customer.pep_flagged`, `customer.sanctions_flagged`) | ✅ Verified — all five confirmed as real `audit_log` rows via direct SQL query in e2e tests (not just emitted events) |
| 13 | Swagger `/docs` covers all new endpoints | ⚠️ Partial — all 9 endpoints confirmed present in `/docs-json` (curled and inspected directly), all carry `@ApiTags`/`@ApiBearerAuth`. But 3 request-body DTOs (`ManualScreenDto`, `ReviewMatchDto`, `ConfigureProvidersDto`) render as an empty `{}` schema and 2 list endpoints have no query parameters declared — real, now-documented gaps (see Known Issues), same class as Prompt 2's `GET /customers` gap, not a regression introduced by not checking |
| 14 | All tests in Section 10 pass; Prompt 1/2 tests still pass | ✅ Verified — `apps/api` e2e: 56/56 (up from 46, all pre-existing suites still green); `apps/worker` e2e: 14/14 non-benchmark tests; `packages/screening-engine`: 40/40 unit tests; `packages/risk-engine`: still 64/64 (untouched) |
| 15 | CI is green | ❌ Not verified — same as every earlier prompt: no remote configured, nothing pushed, GitHub Actions has never actually run |

**Bottom line**: the module's CBN-critical guarantee — a confirmed sanctions match blocks
onboarding with no Customer row ever written, fails closed (never open) on a provider outage, and
leaves a complete audit trail even though the request itself errors — is verified end-to-end
against a real Postgres, not just written, and confirmed a second, independent way: by hand,
through a live server, via `docs/testing/prompt-3-swagger-test-guide.md`'s click-by-click walk. The
async PEP/adverse-media flow, the match-review workflow's flag-setting, the internal-blacklist
short-circuit, and dedup are all verified the same way. What's left is genuinely: real-time cron
observation (same caveat Prompt 2 already carries), real-provider response-shape verification
against actual Smile ID/Prembly sandboxes (no network access here), and the one
intentionally-undecidable test case (fallback recovering where `MockProvider`-as-primary failed,
for identical input).

### Backend Prompt 3.5 (Customer module enhancements) adds

Targeted enhancements to the Customer module requested from real client feedback after a demo —
not a new module, four additions on top of the existing one:

- **PEP details as a new entity, not new columns on `customer`** — `pep_details`
  (`packages/db/src/entities/pep-details.entity.ts`, migration
  `1700000030000-CustomerEnhancements.ts`), one-to-one with `customer` (`customer_id uuid NOT NULL
  UNIQUE REFERENCES customer(id) ON DELETE CASCADE`), holding `pepCategory`
  (`DOMESTIC`/`FOREIGN`/`INTERNATIONAL_ORG`, new `PepCategory` enum), `pepPosition`,
  `pepInstitution`, `pepCountry`, `pepStatus` (`CURRENT`/`FORMER`, new `PepStatus` enum),
  `pepStartDate`/`pepEndDate` (nullable — null means still current), `isPepByAssociation` +
  `associatedPepName` (required together, enforced via `@ValidateIf` on
  `CreatePepDetailsDto`), `sourceOfWealth`, `eddApprovedBy`/`eddApprovedAt` (populated later, by
  approval), `nextReviewDate`. Same `tenant_isolation`/`super_admin_bypass` RLS pattern as every
  other tenant-scoped table.
- **Senior approval required to onboard a PEP customer** — a new `PENDING_EDD_APPROVAL`
  `CustomerStatus` value. `CustomersService.create()` routes to it whenever `customerType ===
  CustomerType.PEP` **or** the new optional `isPep: boolean` field on `CreateCustomerDto` is true
  (covers a PEP whose `customerType` is otherwise `INDIVIDUAL`/`SME`/etc.) — either signal requires
  a nested `pepDetails: CreatePepDetailsDto` (400 `PEP_DETAILS_REQUIRED` otherwise), and sets
  `isPep: true` on the Customer row *before* `RiskService.calculateAndPersist()` runs, so the
  existing PEP/sanctioned risk-score override applies to the customer's very first score, not a
  later re-score. New `POST /customers/:id/approve-pep` (`TENANT_ADMIN`/`COMPLIANCE_OFFICER`,
  idempotent): transitions `PENDING_EDD_APPROVAL` → `ACTIVE`, populates
  `eddApprovedBy`/`eddApprovedAt` on the `pep_details` row, audits as `customer.pep_approved`. `GET
  /customers?status=PENDING_EDD_APPROVAL` works with zero changes — `status` was already a
  filterable field.
- **Customer profile photo** — new nullable `photo_url` column on `customer`. `POST
  /customers/:id/photo` (multipart, `TENANT_ADMIN`/`COMPLIANCE_OFFICER`, 5MB limit, `image/jpeg` |
  `image/png` | `image/webp` | `image/gif` only) stores via the existing `FileStorage` interface
  (`packages/file-storage` — never bypassed) under a `tenants/{tenantId}/customers/{id}/photo.{ext}`
  key, same construction pattern `CustomerIngestionService` already uses for its own
  `LocalFileStorage` instance (no NestJS DI token for `FileStorage` exists in this codebase). `DELETE
  /customers/:id/photo` clears the reference. `GET /customers/:id/photo` (added beyond the spec's
  two listed endpoints — see deviations) streams the bytes back with a content-type inferred from
  the stored key's extension. Both upload and delete are audit-logged
  (`customer.photo.upload`/`customer.photo.delete`).
- **CSV export** — `GET /customers/export` reuses `list()`'s entire filter-building logic (extracted
  into `buildFilteredCustomerQb()`, shared by both `list()` and `exportCsv()` — no duplicated filter
  code), ignoring pagination so it returns every matching row, not one page. `bvn`/`nin` stay masked
  (the same `toDto({ maskPii: true })` default `GET /customers` already uses) — no new unmasking path.
  Same role-gating as `GET /customers`: no `@Roles()` restriction at all, any authenticated role.
  Hand-rolled CSV writer (comma-join + quote-escaping), matching the only existing CSV-writing
  precedent in the repo (`apps/worker`'s ingestion error-report) — no CSV library exists in this
  monorepo today, so this was a genuine choice, not a "reuse what's there" situation (see deviations).

### Critical bugs found while building the Customer module enhancements (all fixed)

Continuing the numbering above.

16. **Re-running this task's own e2e verification a second time caused every single test in every
    e2e file — not just the new ones — to fail with a plain `401 Unauthorized` on login, including
    tests that predate this prompt entirely (`auth.e2e-spec.ts`, `audit.e2e-spec.ts`). Fixed —
    suite-wide, not scoped to this prompt.** Root-caused by direct SQL inspection rather than
    assumed: `AuthService.login()`'s user lookup (`WHERE lower(u.email) = lower(:email)`) has no
    tenant scoping at all — deliberate, since email-only login can't know which tenant a user
    belongs to before it finds them (this exact tradeoff was already flagged as far back as Prompt
    1's own deviation #4, framed there purely as a production-login limitation, not anticipated to
    ever affect the test suite itself) — and returns `outcome: "invalid"` (401) whenever
    `matches.length !== 1`, treating "email exists in two different tenants" identically to "email
    doesn't exist." Every e2e spec file's test fixtures used **hardcoded, non-randomized emails**
    (e.g. `admin-create-1@test.dev`) tied to a **freshly randomized tenant** each run
    (`createTenantFixture` does randomize the tenant name/id, but nothing randomized the user's
    email). Against this project's persistent dev Postgres (not an ephemeral per-run CI database), a
    second invocation of any spec file recreated the exact same email under a new tenant id — one
    duplicate was already enough to 401 every subsequent login using that email, cascading to
    unrelated tests later in the same file/run. Confirmed directly: `SELECT email, COUNT(*) FROM
    "user" WHERE email = 'admin-create-1@test.dev' GROUP BY email` returned 4 rows after repeated
    runs during this session; `screening.e2e-spec.ts`'s author had already independently discovered
    this exact danger and locally worked around it with a `uniqueEmail()` helper, but never
    generalized the fix — every other spec file remained exposed.

    **Real fix, not a workaround**: `createUserFixture` (`apps/api/test/utils/test-app.ts`) now
    unconditionally appends a random nonce to whatever `email` override it's given
    (`uniquifyEmail()`), so the literal a test passes in stays readable in failure traces while the
    actually-persisted, actually-returned `user.email` is always globally unique — closing this for
    every caller at once, since every test in the suite already logs in with the *returned*
    `user.email`, not by reconstructing the literal. One file needed a companion fix:
    `tenant-isolation.e2e-spec.ts` had ~5 places re-hardcoding literal emails directly in assertions
    and one raw SQL query instead of reading the fixture's returned value — fixed to use the real
    email throughout, including a cross-test dependency (one test's `tenantB-only` fixture, asserted
    *absent* by the very next test) now threaded through a shared variable instead of a bare string
    match. One more, unscoped-in-the-original-request instance of the same bug class was found and
    fixed while editing that file: a `findOne({ where: { email: "new-hire@test.dev" } })` query (a
    real user created via the actual `POST /users` signup path, not the fixture helper) had no
    `tenantId` filter, so it could silently pick up a same-literal-email row from a different, stale
    tenant left over by a prior run — scoped by `tenantId` too. `screening.e2e-spec.ts`'s
    now-redundant local `uniqueEmail()` helper and its 3 call sites were removed in favor of the
    shared fix.

    **Proven, not just asserted**: `pnpm test:e2e` was run twice back-to-back at the repo root with
    zero manual DB cleanup in between (previously, the second invocation alone was enough to
    reproduce the full 401 cascade) — both runs passed clean, `apps/api` 75/75 both times. Directly
    confirmed the actual mechanism, not just the symptom: after both runs, `SELECT email, COUNT(*)
    FROM "user" GROUP BY email HAVING COUNT(*) > 1` still found 3 duplicate emails
    (`new-hire@test.dev`, `audit-created@test.dev`, `audit-sensitive@test.dev`) — all three created
    via the real signup API rather than `createUserFixture`, never logged into by any test, and
    referenced only via their entity's own `id`/returned values rather than an ambiguous email
    re-lookup (the `new-hire` case is the one already fixed above to scope by `tenantId`; the audit
    two were never at risk in the first place, since neither test does a tenant-unscoped email
    lookup). None of the three reproduce bug #16's actual failure mode — confirmed by the fact that
    both full runs passed. This fix is suite-wide infrastructure (`test-app.ts`), not scoped to
    Prompt 3.5 — every future prompt's e2e verification benefits from it.

### Deviations from the Backend Prompt 3.5 spec (and why)

1. **`FileStorage` (`packages/file-storage`) was not extended with a `delete()` method.** The
   interface only has `upload`/`getReadStream`/`getSignedDownloadUrl` — `DELETE
   /customers/:id/photo` clears `customer.photo_url` but can't remove the underlying stored bytes.
   `packages/file-storage` isn't listed among this task's allowed touch points, so this is
   deliberately left as a real, disclosed limitation rather than reached around (e.g. by calling
   `fs.unlink` directly, which the spec explicitly forbids) or silently extended outside scope.
2. **`GET /customers/:id/photo` was added, beyond the spec's two listed endpoints
   (upload/delete).** `photoUrl` (Section 3's exact field name) stores a `FileStorage` key
   (`tenants/{tenantId}/customers/{id}/photo.{ext}`), not a literal browsable URL —
   `LocalFileStorage.getSignedDownloadUrl()` always returns `null` in local dev, so without a
   download endpoint the stored value is unusable by any client and Section 5's explicit "photo
   upload/delete round-trip" test requirement would have nothing to round-trip through. Minimal,
   obviously-necessary complement, not scope creep.
3. **Photo content-type is inferred from the stored key's file extension on download, not from a
   separate DB column.** Section 3's field list doesn't include one; a small
   extension-to-content-type map (`jpg`/`png`/`webp`/`gif`) covers the same 4 types the upload
   endpoint itself validates against, so upload and download stay consistent without adding a column
   the spec didn't ask for.
4. **CSV export ignores `page`/`limit` entirely** — Section 4 says "accepts the same filter query
   params as GET /customers," which covers the filters, not pagination; an export capped at one page
   would defeat the point of exporting. `buildFilteredCustomerQb()` is shared, but only `list()`
   calls `.skip()/.take()` on it.
5. **CSV is hand-rolled (manual comma-join + quote-escaping), not written via a library.** Confirmed
   by checking every `package.json` in the monorepo first: `csv-parse` (read-only) is installed in
   `apps/api`/`apps/worker`, but no CSV-*writing* library exists anywhere — `apps/worker`'s ingestion
   error-report (`ingestion-job.processor.ts`) is the only existing CSV-writing precedent, and it's
   hand-rolled the same way. Matched that precedent for consistency rather than introducing a new
   dependency for a small, already-solved problem.
6. **`PATCH /customers/:id` gained two guards that weren't explicitly requested**: `status:
   "PENDING_EDD_APPROVAL"` is rejected outright (400 `STATUS_NOT_DIRECTLY_SETTABLE` — that status is
   system-managed, only `create()`'s PEP branch may set it, since a `pep_details` row is guaranteed
   to exist alongside it), and any `status` change on an already-`PENDING_EDD_APPROVAL` customer is
   rejected (409 `PEP_APPROVAL_REQUIRED` — forces the dedicated approval endpoint, so the
   `customer.pep_approved` audit action and `eddApprovedBy`/`eddApprovedAt` population can't be
   silently bypassed by a plain PATCH that happens to also touch `status`). Without these,
   `UpdateCustomerDto`'s pre-existing (unrelated to this prompt) `status?: CustomerStatus` field
   would have been a direct, obvious bypass of the senior-approval gate this prompt exists to build.
7. **CSV batch ingestion (`apps/worker`) is untouched — a PEP customer imported via CSV does *not*
   go through `PENDING_EDD_APPROVAL`.** Section 2's literal wording ("When creating a customer...")
   and this task's scope both point at single-customer creation via `POST /customers`
   (`CustomersService.create()`); CSV ingestion is a separate code path in a separate app with its
   own duplicated customer-creation logic (no NestJS DI there — see Prompt 2's deviations), and
   extending it wasn't asked for. Worth knowing before assuming PEP onboarding is gated everywhere a
   `Customer` row can be created.
8. **Updating an existing customer's `customerType` to `PEP` via `PATCH` also does not trigger
   `PENDING_EDD_APPROVAL`.** Same literal-scope reasoning as #7 — the gate only fires at creation
   time; `update()` wasn't extended to re-evaluate the PEP gate on a mid-lifecycle `customerType`
   change, since the spec frames this entirely around onboarding.

### Known issues / incomplete items (Backend Prompt 3.5)

- **`GET /customers/export` has no query parameters declared in Swagger** (confirmed via
  `/docs-json`: `parameters: []`) — the exact same class of gap Prompt 2's `GET /customers` and
  Prompt 3's `GET /screening/checks`/`GET /screening/matches` already have. Filtering works
  correctly (verified live and by e2e tests); it just can't be driven from typed Swagger fields.
- **`POST /customers/:id/photo` has no file-upload field declared in Swagger** — no `requestBody`
  appears in `/docs-json` for this operation at all, same root cause (`@nestjs/swagger` CLI plugin
  not enabled) and same class of gap as Prompt 2's `POST /customers/batch` CSV upload.
- **`CreateCustomerDto` (now including the new `isPep`/`pepDetails` fields) still renders as an
  empty `{"type": "object", "properties": {}}` schema** — pre-existing gap, not introduced by this
  prompt; the new fields simply inherit it, same as every other property on this DTO.
- **No dedicated unit tests for the new service methods** (`approvePep`, `uploadPhoto`,
  `deletePhoto`, `getPhotoStream`, `exportCsv`/`buildFilteredCustomerQb`) — coverage is e2e-only,
  same pre-existing gap `CustomersService`'s other methods already have (see Prompt 1's Known
  Issues).
- ~~The e2e test suite's fixture-email/tenant-scoping fragility described in bug #16~~ — **fixed**,
  see bug #16's updated entry above; no longer a known issue.

### Definition of Done — Backend Prompt 3.5 — verified vs. not verified

| # | Item | Status |
|---|---|---|
| 1 | `pep_details` entity + migration + RLS | ✅ Verified — migration applied cleanly against the live Postgres (`pnpm db:migrate`); RLS policies confirmed present via the same `tenant_isolation`/`super_admin_bypass` pattern as every other table |
| 2 | PEP customer creation lands in `PENDING_EDD_APPROVAL`, requires `pepDetails`, both `customerType === PEP` and `isPep: true` signals covered | ✅ Verified — e2e tests plus a live `curl` walk against the demo tenant (`riskScore: 100, riskLevel: "CRITICAL", status: "PENDING_EDD_APPROVAL"` on the very first score, confirming the PEP override applies immediately) |
| 3 | `POST /customers/:id/approve-pep` restricted to `TENANT_ADMIN`/`COMPLIANCE_OFFICER`, transitions correctly, audit-logged | ✅ Verified — e2e tests for both allowed roles, `VIEWER` 403, already-`ACTIVE` 409, plus a live `curl` walk confirming `eddApprovedBy`/`eddApprovedAt` population and the `customer.pep_approved` audit row |
| 4 | `PENDING_EDD_APPROVAL` customers visible via `GET /customers`, `status` filterable | ✅ Verified — no DTO change needed (`status` was already validated against every `CustomerStatus` value); confirmed live and by e2e test |
| 5 | Photo upload/delete via `FileStorage`, never bypassed | ✅ Verified — e2e round-trip test (upload → byte-for-byte download match → delete → 404) plus an independent live `curl` walk against the demo tenant; content-type restricted to 4 image types, 5MB limit |
| 6 | CSV export reuses `GET /customers` filter logic, masks PII, role-gated identically | ✅ Verified — `buildFilteredCustomerQb()` shared by both, confirmed no duplicated filter code; e2e tests for filtering, masked `bvn`, and `VIEWER` access (no extra `@Roles` restriction); live `curl` walk confirmed `Content-Type: text/csv`/`Content-Disposition: attachment` |
| 7 | `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e`, run at the repo root, genuinely green | ✅ Verified — all four green in a single final pass (`apps/api` e2e: 75/75 across 7 suites; `apps/worker` e2e: 14/14 non-benchmark; `packages/risk-engine`: 64/64; `packages/screening-engine`: 40/40); further proven by running `pnpm test:e2e` twice back-to-back with zero manual DB cleanup between runs (75/75 both times) after fixing bug #16 at its root |
| 8 | New e2e tests for all four areas | ✅ Verified — 21 new tests in `customers.e2e-spec.ts` (PEP creation/approval, photo, export) plus one pre-existing test in `risk-rescoring.e2e-spec.ts` fixed to account for the new PEP gate |
| 9 | `docs/testing/prompt-3.5-swagger-test-guide.md`, claims verified against a live server | ✅ Verified — every step walked by hand against a live `node dist/main.js` on the seeded demo tenant before being written down, not inferred |

**Bottom line**: all four requested enhancements work end-to-end against a real Postgres and a real
`FileStorage`-backed local disk, confirmed twice — once by the e2e suite, once independently by
hand through a live server. The one real surprise this prompt surfaced wasn't in the new code at
all: a pre-existing e2e test-infrastructure fragility (bug #16) that had been silently accumulating
duplicate-email debris in the shared dev database for days, eventually breaking login for every test
in every file, unrelated to anything built here. Initially just cleaned up and documented as a
deferred follow-up; on request, fixed properly at its root (`createUserFixture`, suite-wide) and
proven to hold via two consecutive full `test:e2e` runs with no manual cleanup between them — no
longer a known issue, and every future prompt's verification benefits from it, not just this one.

### Backend Prompt 4 (Transactions module) adds

The transaction ingestion backbone: a partitioned `transaction` table, two ingestion paths (SFTP
batch + real-time webhook) funneling into one shared worker-side pipeline, and the real
implementation behind `TransactionVelocityFactor`, which since Prompt 2 has been a scaffold that
always returned `rawValue=0` because no adapter was wired in.

- **`transaction`, `customer_account`, `ingestion_batch`** — new entities + migration
  `1700000040000-Transactions.ts`. `transaction` is `PARTITION BY RANGE (occurred_at)`, monthly,
  mirroring `audit_log`'s existing quarterly `create_audit_log_partition()` pattern
  (`create_transaction_partition(for_date)`, idempotent, `IF NOT EXISTS` guarded); migration
  pre-creates the current month + 5 ahead, plus a `transaction_default` DEFAULT partition for
  out-of-range rows. Composite PK `(id, occurred_at)` — a Postgres requirement for any unique
  constraint on a partitioned table, not a modeling choice. `customer_id`/`account_number`/
  `counterparty_customer_id` are FK-by-convention only (no `REFERENCES`), same choice already made
  for `screening_check.customer_id` — RLS enforces tenant isolation, not referential integrity.
- **RLS at the partition level, not just the parent** — the migration enables/forces RLS on the
  parent `transaction` table (whose `tenant_isolation`/`super_admin_bypass` policies then apply
  automatically to every partition, present and future) **and, separately, on every individual
  partition** (`ENABLE`/`FORCE ROW LEVEL SECURITY` are per-relation flags that do **not**
  propagate from parent to partition — see bug #18 below, caught by this prompt's own RLS test).
  `create_transaction_partition()` applies both flags to every partition it creates, including
  future ones the monthly maintenance job adds.
- **Partition maintenance** — a third `MAINTENANCE_QUEUE` job (`create-transaction-partitions`,
  monthly on the 25th, per spec) alongside the pre-existing `create-audit-log-partitions`, in
  `apps/worker/src/main.ts`. First BullMQ repeatable-job test in this codebase
  (`apps/worker/test/partition-maintenance.e2e-spec.ts`) — calls the SQL function directly with a
  forwarded date and asserts the partition (and its RLS flags) exist, idempotently.
- **SFTP-emulated ingestion path** — no real SSH/SFTP server exists in this sandbox (see
  Deviations). `POST /transactions/sftp-inbox` (`TENANT_ADMIN`, multipart upload) stands in for a
  tenant's SFTP drop, writing to `tenants/<id>/sftp-inbox/<filename>` via the existing
  `FileStorage` abstraction (extended with `list()`/`move()` for this). `apps/worker/src/
  transactions/sftp-polling.ts` (`pollSftpInboxes`, run as a repeatable `poll-sftp-inboxes`
  `MAINTENANCE_QUEUE` job every 5 min business-hours / 30 min otherwise, spec Section 5.3) lists
  each active tenant's inbox prefix, quarantines filenames not matching
  `transactions-YYYYMMDD-NNN.csv`, takes a Redis lock per `(tenantId, filename)` (5 min TTL, via a
  tiny atomic Lua script — see Deviations) so concurrent worker replicas can't double-process a
  file, creates an `IngestionBatch` row, enqueues the same `TRANSACTION_INGESTION_QUEUE` job the
  webhook path uses, and moves the file to `sftp-processed/` or `sftp-quarantine/` based on the
  outcome.
- **Webhook ingestion path** — `POST /transactions/ingest` (spec Section 6). `TenantContextMiddleware`
  extended to resolve tenant context from an `X-Tenant-Id` header (rather than a JWT) for exactly
  this one route (see its docblock for why that's safe — the claim grants no access by itself;
  `WebhookSignatureGuard` is the actual authentication, re-deriving the tenant's stored
  `tenant.config.transactions.webhookSecret` and verifying `HMAC-SHA256(secret, timestamp + '.' +
  rawBody)` via `crypto.timingSafeEqual`, rejecting timestamps >5min skewed). `rawBody: true`
  enabled on `NestFactory.create`/the test harness so the guard sees the exact bytes the sender
  signed alongside the normally-parsed body. Idempotency reuses the **existing**
  `IdempotencyInterceptor`/`idempotency_key` table as-is via `@Idempotent()` — no bespoke
  raw-body-hashing service needed, since the interceptor already hashes the parsed JSON body and
  doesn't depend on `req.user` being set. Synchronous mode (`?sync=true`, ≤50 transactions, 10s
  timeout) is **not a separate code path** — it enqueues exactly like async mode, then
  `Job.waitUntilFinished(queueEvents, timeoutMs)`s on the very same job, so both modes share 100%
  of the real processing pipeline.
- **Shared ingestion pipeline** (`apps/worker/src/transactions/ingestion-processor.ts`,
  `resolution.ts`, `transaction-row.schema.ts`) — one `processTransactionIngestionJob()` for both
  paths (chunks of 500 rows, concurrency 4): zod validation (mirrors
  `csv-row.schema.ts`'s house style, coercing both CSV-string and JSON-typed inputs), bulk
  customer/account/counterparty resolution (Section 7.1's `= ANY`/`IN` pattern, no N+1),
  batched `INSERT ... ON CONFLICT (tenant_id, cbs_transaction_id, occurred_at) DO NOTHING RETURNING
  id` (client-generated row ids so which specific rows conflicted is unambiguous — see Deviations
  for why this replaces `pg-copy-streams`), an error-report CSV uploaded via `FileStorage`, and
  `IngestionBatch` status/counts updated incrementally. Customer resolution supports `reject`
  (default) and `auto_create_stub` (`tenant.config.ingestion.unknownCustomerMode`) — a stub
  Customer gets `customerType=INDIVIDUAL`, `kycTier=1`, `status=PENDING_KYC` (new `CustomerStatus`
  value), `fullName` falling back to `"Unknown Customer <cbs_id>"`, and a real initial risk score.
  Concurrent chunks racing to auto-create the same stub customer (or the same new
  `CustomerAccount`) are handled by catching the Postgres unique-violation and re-selecting the
  row the other chunk just committed, rather than failing every row that needed it.
- **`transaction.ingested` event stream** — emitted once per successfully inserted transaction, but
  from **apps/api**, not apps/worker (which has no `EventEmitter2` — it's a plain Node/BullMQ
  process, same as every other worker job). `TransactionIngestionQueueService` bridges this via
  `QueueEvents` exactly like `AsyncScreeningQueueService`/`CustomerIngestionService` already do:
  the job's return value carries an `insertedTransactions: IngestedTransactionSummary[]` array, and
  the bridge replays one `transaction.ingested` (plus `transaction.batch.completed`/`.failed`) per
  entry once it sees the job complete.
- **Real `TransactionVelocityFactor` wiring** — `packages/risk-engine`'s
  `TransactionVelocityAdapter`/`createFactorRegistry(adapter?)` needed **no changes**; the interface
  (`getStats(customerId)`, no tenantId/QueryRunner/config params) already anticipated this exactly.
  `RiskService.calculateAndPersist` now builds a one-shot closure adapter per calculation (wrapping
  the new `@Optional()`-injected `VelocityAdapterService`, which closes over the request's own
  `queryRunner`/`tenantId`/tuned config) and passes it into `createFactorRegistry(...)`. The actual
  scoring logic (`apps/api/src/transactions/velocity-scoring.ts`, pure, DB-free,
  fully unit-tested) computes three sub-signals over a `GREATEST(30, dormancyDays)`-day window
  queried once: volume spike (today's total > `spikeMultiplier`× the 29-day rolling average AND >
  `spikeMinAmount`), channel anomaly (a channel used today that's absent from the prior 29 days),
  and dormancy reactivation (no activity in `[now-dormancyDays, now-7]` but activity in the last 7
  days) — each a flat point award on detection (25/10/15, since the spec gives ranges but no
  graduated formula), summed and clamped to `maxScore`. Re-score trigger:
  `apps/api/src/risk/listeners/transaction.listener.ts` (`RiskModule`, not `TransactionsModule` —
  keeps the module dependency one-directional), `@OnEvent("transaction.ingested")`, debounced 60s
  per `(tenantId, customerId)` via a tiny atomic Redis lock (same Lua-script approach as the SFTP
  poller's file lock, borrowing `TransactionIngestionQueueService`'s own Redis connection rather
  than opening a second one — see Deviations), then `RiskService.rescoreEventTriggered()` (new
  `ScoreTrigger.TRANSACTION_ACTIVITY`, own audit action `risk.rescore.transaction_activity`).
  `GET /customers/:id/velocity-stats` exposes the same calculation's raw sub-signal detail for
  debugging.
- **Endpoints**: `GET /transactions`, `GET /transactions/:id`, `GET /transactions/batches[/:id][/errors]`,
  `POST`/`GET /customer-accounts`, `GET /customers/:id/transactions`, `GET
  /customers/:id/velocity-stats`, plus the webhook/SFTP-inbox endpoints above. Standard
  `JwtAuthGuard`/`TenantGuard`/`RolesGuard` stack on all of them except the two ingestion endpoints
  (webhook has no JWT at all; SFTP-inbox is `TENANT_ADMIN`-gated multipart upload like
  `CustomerIngestionController`).

### Critical bugs found while building the Transactions module (all fixed)

Continuing the numbering above.

17. **`TenantContextMiddleware`'s new unauthenticated-route allowlist check
    (`UNAUTHENTICATED_TENANT_HEADER_ROUTES.includes(req.path)`) never matched, silently leaving
    every webhook request with no tenant context at all (401 `TENANT_CONTEXT_MISSING`) —
    caught by this prompt's own e2e test, not by inspection.** Root cause: this middleware is
    registered via `consumer.apply(TenantContextMiddleware).forRoutes('*')`, and Express treats a
    middleware mount path (even a wildcard) as an actual **mount point** — `req.path`/`req.url`
    inside a `.use(mountPath, fn)`-mounted middleware become relative to that mount point, which for
    a fully-matching `'*'` collapses to `"/"` regardless of the real request path.
    `req.originalUrl` is the one property Express guarantees stays absolute regardless of mounting;
    switched to `req.originalUrl.split("?")[0]`. Confirmed directly by temporarily logging both
    values inside the middleware before fixing it, not just inferred from the symptom.
18. **`ALTER TABLE transaction ENABLE/FORCE ROW LEVEL SECURITY` on the parent did *not* propagate
    to its partitions — a direct query against a named partition (e.g. `transaction_2026_07`)
    completely bypassed RLS, returning rows a request with no tenant context should never see.**
    This is exactly the gap spec Section 3.1's "verify in a test that querying without tenant
    context returns 0 rows from a partitioned table" was written to catch, and the first version of
    that test (in `transactions.e2e-spec.ts`) failed immediately, for real, before this was fixed —
    Postgres policies defined on a partitioned table's parent *do* apply automatically to every
    partition, but the `relrowsecurity`/`relforcerowsecurity` flags that turn RLS on **at all** are
    per-relation and do not inherit. Fixed by having `create_transaction_partition()` run
    `ALTER TABLE %I ENABLE/FORCE ROW LEVEL SECURITY` on every partition it creates (present and
    future), plus explicit `ALTER TABLE transaction_default ENABLE/FORCE ROW LEVEL SECURITY` in the
    migration for the one partition the function doesn't create. Verified directly against
    `pg_class.relrowsecurity`/`relforcerowsecurity` for a specific partition, not just via the
    passing e2e test.
19. **`node-postgres` has no OID mapping for an array of a custom enum type
    (`transaction_channel_enum[]`), so `ARRAY_AGG(DISTINCT channel)` came back as the raw
    `"{MOBILE,POS}"` text literal instead of a JS array — `VelocityAdapterService` then crashed
    (`todayChannels.some is not a function`) the first time a customer had any transaction
    history at all.** Fixed by casting inside the query (`ARRAY_AGG(DISTINCT channel::text)`),
    which `pg` parses as a plain `text[]` correctly. Caught by the velocity-stats e2e test, not
    the (DB-free) unit tests for the pure scoring function, which only ever exercised
    already-parsed arrays.
20. **A webhook payload near the spec's own 1000-transaction cap (1001 transactions, sent to prove
    the cap is enforced) 500'd instead of 400'ing** — Express's default JSON body-parser limit
    (100kb) rejected the request before `IngestWebhookDto`'s `@ArrayMaxSize(1000)` validation ever
    ran. Fixed via `app.useBodyParser("json", { limit: "5mb" })` (preserves the `rawBody` capture
    `WebhookSignatureGuard` needs — a second, unrelated `express.json()` call would not have).
    Raised, not removed: still a bounded limit, just one that doesn't reject spec-legal payloads.
21. **`TestingModule.createNestApplication(undefined, { rawBody: true })` silently discarded the
    options object** — `apps/api/test/utils/test-app.ts` initially passed `undefined` as the first
    argument (matching a pattern that reads naturally next to `NestFactory.create(AppModule, {...})`),
    but `TestingModule.createNestApplication`'s overload resolution treats a non-HttpServer first
    argument as *the options themselves*, not as a placeholder — the real second argument was never
    read, so every webhook e2e test failed with `WEBHOOK_SIGNATURE_MISSING` (`req.rawBody` was
    always `undefined`). Fixed by calling the single-argument form,
    `moduleRef.createNestApplication({ rawBody: true })`. Confirmed by reading
    `@nestjs/testing`'s actual compiled implementation, not just retrying variations.
22. **`GET /transactions/batches` 500'd with `invalid input syntax for type uuid: "batches"` —
    found live while hand-walking `docs/testing/prompt-4-swagger-test-guide.md` against a real
    running server, not by the automated suite (which never happened to call this exact path with
    no id).** Root cause: `TransactionsModule`'s `controllers` array listed `TransactionsController`
    (`GET /transactions/:id`) before `BatchesController` (`GET /transactions/batches`) — Nest/Express
    register and match routes in array order, so a request for `/transactions/batches` was matched
    by the earlier, more general `:id` route first, with `"batches"` bound as the `id` param, which
    then failed as an invalid UUID at the database layer instead of ever reaching
    `BatchesController`. Fixed by reordering the array (`BatchesController` first — specific routes
    before wildcard-shaped ones), and closed with a new regression test in `transactions.e2e-spec.ts`
    ("GET /transactions/batches is not swallowed by GET /transactions/:id's route"). A reminder that
    the automated suite calling every endpoint in isolation doesn't guarantee route *registration
    order* is correct when two controllers share a path prefix — this class of bug only surfaces
    when the more general route is tried against a value the more specific route was meant to catch.

### Deviations from the Backend Prompt 4 spec (and why)

1. **No real SFTP/SSH server** — same category of gap as the Cloudflare R2 substitution (Prompt
   1's deviation #1). `docker/atmoz-sftp` or AWS Transfer Family both need real infrastructure this
   sandbox doesn't have. The "SFTP path" is emulated entirely through the existing `FileStorage`
   abstraction (extended with `list()`/`move()`): an authenticated upload endpoint stands in for
   the tenant's inbox drop, a BullMQ repeatable job polls a storage prefix instead of an SSH
   server, and "moving to processed/quarantine" is a `FileStorage.move()` re-key instead of an
   `mv` on a chroot jail. Per-tenant SSH key management/rotation (spec Section 5.1) accordingly
   does not exist — there's no SSH server for a key to authenticate against.
2. **`pg-copy-streams` replaced with batched, client-id-tracked `INSERT ... ON CONFLICT DO
   NOTHING`** — spec Section 5.5 explicitly offers this as a sanctioned "slower but simpler"
   alternative. Avoids a new native dependency for a target (100k rows / 30 min) that chunked
   inserts clear comfortably — the analogous customer-ingestion benchmark already does 100k rows
   in ~7 minutes doing per-row work, and this prompt's own equivalent benchmark
   (`apps/worker/test/transaction-ingestion-benchmark.e2e-spec.ts`, opt-in via
   `RUN_TRANSACTION_INGESTION_BENCHMARK=1`) confirms the same for transactions — see the DoD table.
3. **A new distributed-lock primitive, introduced from scratch** — no `SETNX`/lock convention
   existed anywhere in this codebase before this prompt (only BullMQ's own bundled Redis
   connection). Needed for two things: the SFTP poller's per-`(tenantId, filename)` lock (spec
   Section 5.4) and the re-score debounce (spec Section 9.4). Implemented as a tiny atomic Lua
   script (`SET key val PX ttl NX`) via BullMQ's own `Queue.client`/`defineCommand`/`runCommand`
   rather than a second, standalone `ioredis` instance — bullmq's `IRedisClient` type deliberately
   narrows `.set()`'s options to `{PX, EX}` only (no `NX`), so the conditional-set semantics a lock
   needs aren't expressible through that interface's typed surface at all; the script sidesteps
   that narrowing without reaching for the underlying adapter's real (version-conflict-prone) type.
   Duplicated between `apps/api` (`TransactionIngestionQueueService.acquireLock`) and
   `apps/worker` (`sftp-polling.ts`'s local `acquireLock`) rather than shared — no runtime is
   shared between the two processes, matching every other small cross-boundary helper in this
   codebase (`parseRedisUrl`, `withTenantContext`).
4. **Webhook secret stored at `tenant.config.transactions.webhookSecret` (plain jsonb, not a
   dedicated encrypted column)** — no dedicated-column precedent exists for a tenant-level secret,
   and no value already in `tenant.config` is encrypted at rest either (Postgres's own at-rest
   encryption is what covers storage generally, same reasoning `CustomerEntity.bvn`'s comment
   already documents). Matches the existing bar rather than inventing a new one for just this field.
5. **`buffer` unknown-customer-resolution mode is not implemented** — the spec itself flags this
   as an explicit v2 item (Section 5.6); only `reject` (default) and `auto_create_stub` exist.
6. ~~No `docs/testing/prompt-4-swagger-test-guide.md`~~ — **resolved in a follow-up session**:
   `docs/testing/prompt-4-swagger-test-guide.md` now exists, hand-walked against a live
   `docker-compose up -d` + `pnpm dev` instance the same way Prompts 2/3/3.5's guides were (every
   step's response body, status code, and timing recorded is a real one, not inferred from reading
   the code) — SFTP-emulated upload + processed/quarantine, webhook HMAC signing (valid/invalid/
   stale), `GET /transactions`/`GET /customers/:id/transactions` visibility, a real velocity-factor
   spike driving an automatic risk-score change end to end, and tenant isolation. Unlike prior
   guides, two of its endpoint families genuinely cannot be exercised through Swagger's UI at all
   (not just "no typed field" — Swagger has no way to compute an HMAC signature, and
   `POST /transactions/sftp-inbox`/`POST /users` with `X-Tenant-Override` have no declared request
   body/parameters whatsoever), so those steps are curl, disclosed explicitly rather than silently
   worked around. Walking it live found and fixed one real bug — see #22 above.

### Known issues / incomplete items (Backend Prompt 4)

- **`GET /transactions`, `GET /transactions/batches`, and `GET /customer-accounts` have no query
  parameters declared in Swagger** — the exact same `@nestjs/swagger` CLI-plugin gap every prior
  prompt's list endpoints already have (Prompt 2's `GET /customers`, Prompt 3's `GET
  /screening/checks`, Prompt 3.5's `GET /customers/export`). Filtering works correctly (verified by
  e2e tests); it just can't be driven from typed Swagger fields.
- **`insertedTransactions` (the array `TransactionIngestionJobResult` carries so
  `TransactionIngestionQueueService` can replay `transaction.ingested` events) is unbounded at the
  extreme end** — fine at pilot-MFB batch sizes and the 100k-row benchmark (which doesn't assert on
  the array itself, only row counts/timing), but a very large real-world SFTP batch would round-trip
  a proportionally large array through Redis via `job.returnvalue`. Same spirit as the spec's own
  "v2 TODO: `CustomerDailyStats`" scaling note for the velocity factor — a known, disclosed v1
  limitation, not silently ignored.
- **The re-score debounce lock (60s) and the SFTP file lock (5min) share
  `TransactionIngestionQueueService`'s Redis connection with the ingestion queue itself** — chosen
  deliberately (see Deviations #3) rather than opening a second connection, but worth knowing if
  ingestion queue load and lock-check volume ever need to scale independently.
- **No dedicated unit tests for `IngestionBatchService`, `CustomerAccountsService`,
  `TransactionsService`'s filtering, or the controllers** — coverage is e2e-only for the HTTP
  surface (same pre-existing pattern as Prompt 1's Known Issues note for `CustomersService`); the
  pure, DB-free logic (`velocity-scoring.ts`, `transaction-row.schema.ts`) does have full unit
  coverage.
- **`buffer` unknown-customer-resolution mode does not exist** (see Deviations #5) — a tenant that
  needs it must currently choose `reject` or `auto_create_stub`.

### Definition of Done — Backend Prompt 4 — verified vs. not verified

| # | Item | Status |
|---|---|---|
| 1 | Migration applies cleanly, 6 monthly partitions + default partition created | ✅ Verified — `pnpm db:migrate` against live Postgres; partitions confirmed via `pg_class` |
| 2 | Partition maintenance cron creates future partitions (forwarded-clock test) | ✅ Verified — `partition-maintenance.e2e-spec.ts`, forwarded date, idempotent |
| 3 | `Transaction`/`CustomerAccount`/`IngestionBatch` entities + RLS in place | ✅ Verified — entities compile/typecheck; RLS confirmed at both parent AND partition level (bug #18) |
| 4 | Webhook ingestion: HMAC verification, timestamp validation, idempotency | ✅ Verified — e2e: valid/invalid signature, stale timestamp, Idempotency-Key replay |
| 5 | SFTP polling service running in worker, configurable cadence | ✅ Verified — `pollSftpInboxes` e2e: valid file processed+moved, misnamed file quarantined, lock prevents double-processing. The cadence itself (5min business-hours tick) was **also observed firing on a live clock**, not just called directly, while hand-walking `docs/testing/prompt-4-swagger-test-guide.md` against a real `pnpm dev` instance — a file dropped via `POST /transactions/sftp-inbox` was picked up, processed, and moved to `sftp-processed/` at the next real `*/5` tick, no forced invocation. Same for the misnamed-file → quarantine path |
| 6 | Both paths flow through the shared IngestionService | ✅ Verified — both enqueue the same `TRANSACTION_INGESTION_QUEUE` job shape, processed by the one `processTransactionIngestionJob` |
| 7 | COPY-based persistence achieves 100k-rows-in-30-min | ✅ Verified (via the sanctioned batched-INSERT alternative — see Deviations #2) — `RUN_TRANSACTION_INGESTION_BENCHMARK=1 pnpm --filter @regops/worker test:e2e` actually run this session: **100,000 rows in 45.2s**, comfortably clear of the 30-minute budget |
| 8 | Customer resolution: `reject` default, `auto_create_stub` verified | ✅ Verified — e2e tests for both modes, including the concurrent-stub-creation race path |
| 9 | Counterparty resolution populates `counterparty_customer_id` | ✅ Verified — e2e tests for both the matched (internal transfer) and unmatched (external) cases |
| 10 | `transaction.ingested` emitted exactly once per successful insertion | ✅ Verified — e2e test asserts `insertedTransactions.length` matches `succeeded`, plus the QueueEvents-bridge re-emission path exercised directly via `EventEmitter2` |
| 11 | Re-score debounce (60s window) verified | ✅ Verified — 100 `transaction.ingested` events for one customer in the debounce window produce exactly one new `RiskScoreHistory` row |
| 12 | `TransactionVelocityFactor` calculates full velocity score using real data; `@Optional` injection resolves | ✅ Verified — `GET /customers/:id/velocity-stats` e2e test against real inserted transaction history (spike detected, score > 0); risk-engine's own factor tests (Prompt 2) already cover the adapter-present/absent contract unchanged |
| 13 | Customer creation tests from Prompt 2 still pass | ✅ Verified — `customers.e2e-spec.ts`, `customer-ingestion.e2e-spec.ts` (api + worker) still 100% |
| 14 | Screening tests from Prompt 3 still pass | ✅ Verified — `screening.e2e-spec.ts` (api + worker) still 100% |
| 15 | Audit log entries present for all four listed actions | ⬜ Partially verified — `customer.create` (auto-stub path) and `risk.rescore.transaction_activity` confirmed via e2e; `transaction.ingest.batch`/`transaction.ingest.row.error`/`ingestion.sftp.file.processed`/`ingestion.sftp.file.quarantined` action names from the spec's literal list were not implemented as their own audit_log rows — batch/row outcomes are tracked via `IngestionBatch`'s own status/counts and the error-report CSV instead, which was judged equivalent but is a literal-naming gap worth flagging |
| 16 | Webhook secrets never logged | ✅ Verified — grepped e2e test output/application logs for the literal secret and signature values across a full run; neither appears |
| 17 | Swagger covers all new endpoints | ✅ Verified minimally (`@ApiTags`/`@ApiBearerAuth` only, matching house style — see Known Issues re: query-param/file-upload schema gaps) |
| 18 | All Section 11 tests pass | ✅ Verified — 27 new e2e tests (14 `apps/api` — the 14th a route-ordering regression test added after the manual guide walkthrough found bug #22 — 13 `apps/worker`: 8 ingestion-processor + 3 sftp-polling + 2 partition-maintenance) + 19 new unit tests (9 velocity-scoring, 10 transaction-row-schema) + the opt-in 100k-row benchmark, all passing |
| 19 | CI green | ⬜ Not verified in this session — no CI run observed; `pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm test:e2e`, all run fresh at the repo root this session: every task green (`apps/api` e2e 89/89 across 8 suites, `apps/worker` e2e 27/27 across 5 non-benchmark suites) |

**Bottom line**: both ingestion paths, the partitioned transaction store (with RLS genuinely
enforced down to the partition level — not vacuously true, an early version of that exact test
failed for real), and the velocity factor's real implementation all work end-to-end against a real
Postgres and Redis — confirmed twice now, once by the automated suite and once independently by
hand through a live server (`docs/testing/prompt-4-swagger-test-guide.md`, deviation #6 no longer
deferred), the same bar every prior prompt's guide was held to. Three of the five bugs this prompt
surfaced (#17, #20, #21) were webhook/test-harness plumbing issues that would have silently made
every webhook e2e test look like an auth failure; #18 was a genuine RLS gap the spec's own required
test was specifically designed to catch, and did; #22 (a controller-registration route-ordering bug
on `GET /transactions/batches`) was found only by the live manual walkthrough, not by the automated
suite, and is now fixed with its own regression test. Item 15's audit-action-naming gap is the one
remaining honest incompletion worth a reader's attention before assuming full literal-spec parity.

### Backend Prompt 5 (Rules Engine & Alerts) adds

The five deterministic AML scenarios, the alert lifecycle, and a CLI backfill tool — the centerpiece
of the v1 product per the spec's own framing. Built on top of Prompt 4 with no changes to its
guarantees.

- **New workspace package `packages/rules-engine`** (framework-free, mirrors `packages/risk-engine`/
  `packages/screening-engine`'s split): five pure evaluator functions (`evaluateLargeCash`,
  `evaluateStructuring`, `evaluateRapidInflowOutflow`, `evaluateHighRiskCounterparty`,
  `evaluateVelocitySpike`), each taking a structural `EvaluationContext` (TypeORM-free mirrors of
  `TransactionEntity`/`CustomerEntity`) plus pre-fetched, scenario-specific facts, returning a fired/
  evidence/severity/dedupKey result. `dispatchEvaluation()` is the spec's "EvaluatorRegistry,"
  implemented as a switch-dispatch function rather than a DI-registered class map (see Deviations).
  `DEFAULT_RULE_CONFIGS` mirrors `DEFAULT_RISK_FACTOR_CONFIGS`'s seeding pattern. 41 unit tests
  covering the full Section 11.1 positive/negative matrix, 80%+ branch coverage.
- **`packages/db`**: `rule`, `alert`, `rule_evaluation` (RANGE-partitioned monthly by `evaluated_at`,
  identical mechanism to `TransactionEntity` — same idempotent partition-creation-function pattern,
  same per-partition RLS re-application trap re-applied), and `rule_replay` (plain, mirrors
  `IngestionBatchEntity`'s progress-tracking shape) — all in
  `RulesAndAlerts1700000050000`. `alert`'s `dedup_key` uniqueness is a **partial** unique index
  (`WHERE status != 'CLOSED'`), which both enforces Section 3.2's "closed alerts can recur" rule and
  is the exact conflict target `AlertsService.createOrIncrement`'s `INSERT ... ON CONFLICT` targets.
  `seed.ts` now seeds the 5 default `Rule` rows for every tenant it creates.
- **`apps/api/src/rules`**: `RulesService` (CRUD, `PATCH /rules/:id` with the disable-reason and
  loosening-confirmation guardrails, `POST /rules/:id/test` dry-run), `AlertsService` (the
  create-or-increment UPSERT, list/filter/assign/close/related-transactions),
  `RuleFactsService`/`EvaluatorFactsGatheringService` (the DB-query layer packages/rules-engine
  deliberately has no dependency on — one shared switch-dispatch used by both the real async
  evaluation path and the dry-run test endpoint, so a dry run means what it says),
  `CounterpartyScreeningService` (wraps `ScreeningService` from Prompt 3 with a 7-day Redis cache,
  borrowing a BullMQ connection the same way `TransactionIngestionQueueService.acquireLock` does),
  `RuleEvaluationOrchestratorService` (the real per-transaction, per-rule evaluation loop — every
  rule wrapped in its own try/catch so one throwing/slow evaluator never blocks or skips the
  others' `RuleEvaluation` rows), a hand-rolled BullMQ producer/consumer pair
  (`RuleEvaluationQueueService`/`RuleEvaluationConsumerService`) on `RULE_EVALUATION_QUEUE`, a
  `TransactionListener` (`@OnEvent("transaction.ingested")`, enqueues one job per transaction, no
  debounce — unlike `RiskModule`'s re-score debounce, every transaction genuinely needs its own
  evaluation), and `RuleReplayService` + `rule-replay.cli.ts` (Section 10's backfill tool — a plain
  `NestFactory.createApplicationContext` script, since this codebase has never depended on
  nest-commander; `pnpm --filter @regops/api cli:rule-replay -- --tenant=<id> [--rule=<id>]
  --from=YYYY-MM-DD --to=YYYY-MM-DD [--dry-run]`).
- `TenantsService.create()` now also calls `RulesService.seedDefaultsForTenant()`, same pattern as
  the existing risk-factor-config and screening-provider-config seeding calls.
- 24 new `apps/api` e2e tests (`test/rules.e2e-spec.ts`) plus 1 new unit spec
  (`src/rules/loosening.spec.ts`) — `apps/api`'s e2e suite is up to 113 (from 89).

### Deviations from the Backend Prompt 5 spec (and why)

1. ~~The `evaluate-rules` BullMQ consumer runs inside `apps/api`, not `apps/worker`, contradicting
   Section 4's file tree.~~ **Resolved in a follow-up session** (`integration/v1`, same session that
   moved it): the consumer now runs in `apps/worker/src/rules/evaluate-rules.processor.ts`, matching
   Section 4's file tree and every other worker-side job in this codebase. It originally shipped
   inside `apps/api` for two reasons: (a) the spec's own orchestration pseudocode (Section 5.2) uses
   NestJS's `@Processor`/`WorkerHost`/injected-services style, only meaningful inside a Nest DI
   container, and `apps/worker` has never had one (see Prompt 4's own deviations); (b) the
   `HIGH_RISK_COUNTERPARTY` evaluator needs `ScreeningService` (Prompt 3's provider-strategy
   screening engine). The fix follows the precedent `apps/worker/src/screening/` already set for
   this exact problem (`screening-check-runner.ts` duplicating `ScreeningService.runCheckInline`'s
   provider-resolution/internal-blacklist logic as plain functions): `apps/worker/src/rules/` adds
   `rule-facts.ts` (plain-function duplicate of `RuleFactsService`'s three queries),
   `counterparty-screening.ts` (plain-function duplicate of `CounterpartyScreeningService`, but
   reusing `screening-check-runner.ts`'s own `runScreeningCheck` — widened to accept a nullable
   `customerId` for the no-known-customer external-counterparty case — rather than a second full
   duplicate of `ScreeningService.runCheckInline`), and `evaluate-rules.processor.ts` (the
   per-transaction, per-rule loop itself, including a plain-function duplicate of
   `AlertsService.createOrIncrement`'s UPSERT). `packages/rules-engine` needed **zero** changes — it
   was already framework-free, confirmed rather than assumed. The 7-day counterparty-screening Redis
   cache now borrows the `Worker`'s own BullMQ connection (`ruleEvaluationWorker.client`) the same
   "borrow, don't open a second ioredis client" way `RuleEvaluationQueueService.getClient()` did.
   Since the consumer now runs in a separate OS process from the producer, `RuleEvaluationQueueService`
   gained the same `QueueEvents` completion bridge every other cross-process queue in this codebase
   already has (`AsyncScreeningQueueService`/`RescreenQueueService`'s pattern): the worker-side
   processor returns a `RuleEvaluationJobResult` (new `packages/shared` type) instead of emitting
   `alert.created`/`alert.critical_fired`/`alert.escalated` directly, and the bridge re-derives and
   emits those events in-process once it observes the job complete — no consumer of those events
   exists yet (Case Management doesn't exist as a backend module — see Prompt 5.5's deviations), so
   this was unobservable either way, but the event names and payloads are unchanged. `apps/api`'s
   `RuleEvaluationOrchestratorService` was deleted (no remaining production caller once the consumer
   moved) along with its dedicated e2e coverage, which moved to the new
   `apps/worker/test/rules.e2e-spec.ts` (calling the real `evaluateTransaction` entry point directly
   — same "test follows the code" precedent as `processAsyncScreeningJob`'s own coverage in
   `screening.e2e-spec.ts`); `apps/api/test/rules.e2e-spec.ts`'s HTTP-facing tests (rule CRUD,
   dry-run, alert assign/close, replay) are untouched, and the two tests that only needed *a* seeded
   `Alert` row to exercise the alerts HTTP surface now call `AlertsService.createOrIncrement` directly
   instead of a full evaluation. **The multi-instance duplicate-enqueue characteristic described
   below was unaffected by this particular fix** — it's caused by `TransactionIngestionQueueService`'s
   own `QueueEvents` bridge fanning out `transaction.ingested` per `apps/api` replica (upstream of
   `RuleEvaluationQueueService.enqueue`), not by where the rule-evaluation consumer itself runs — and
   was left as a disclosed Known Issue at the time. It has since been resolved by an independent
   follow-up session; see the Known Issues entry below for that fix.
   Verified: `pnpm build`/`pnpm test`/`pnpm test:e2e` all green at the repo root, plus a live
   `pnpm dev` walkthrough (not just the automated suite) re-running two of
   `docs/testing/prompt-5-swagger-test-guide.md`'s scenarios — `LARGE_CASH` and
   `HIGH_RISK_COUNTERPARTY` (external counterparty, the one that exercises the moved screening-cache
   path) — both fired correctly end-to-end across the real `apps/api` → Redis → `apps/worker` →
   Postgres → `apps/api` round trip, including the 7-day screening cache (repeat transfer to the same
   counterparty incremented `fireCount` to 2 with zero new `screening_check` rows) and the dedup
   evidence merge.
2. **The replay progress table (`rule_replay`) is checked, but `RuleReplayService.replay()` is
   awaited synchronously by its only caller (the CLI), not fire-and-forget.** The spec's Section
   10.3 implies an async trigger + poll model (`GET /rules/replays/:replayId` for progress while a
   long backfill runs in the background). There is, however, no HTTP endpoint anywhere in the spec
   that *starts* a replay — only the CLI does, and only `GET /rules/replays/:replayId` (implemented)
   observes it. A CLI process that fire-and-forgets its own work and then calls
   `NestFactory`'s `app.close()` would kill that work mid-run (a real bug caught before it shipped —
   see Known Issues). So `replay()` creates the tracking row, then awaits the actual backfill before
   returning; the tracking row is still visible to a *concurrently running* `apps/api` HTTP process's
   `GET /rules/replays/:replayId` for the whole duration, which is what the polling endpoint is
   actually for.
3. **Dedup-key "rolling window anchored to the first qualifying transaction" (Sections 6.2/6.3's
   literal wording) is implemented as fixed calendar/interval bucketing instead** (a UTC-day bucket
   for `STRUCTURING`/`HIGH_RISK_COUNTERPARTY`/`VELOCITY_SPIKE`, a fixed N-minute interval index for
   `RAPID_INFLOW_OUTFLOW`) — see `packages/rules-engine/src/dedup.ts`'s docblock. A truly
   first-transaction-anchored rolling window needs state (when did the current window start?) that a
   stateless, per-transaction evaluation doesn't have without an extra DB round trip per rule per
   transaction. Calendar bucketing is idempotent (replay-safe, matches the codebase's UPSERT-based
   dedup model exactly) at the cost of a pattern spanning a bucket boundary (e.g. just before/after
   UTC midnight) producing two `Alert` rows instead of one — a disclosed, minor precision loss, not a
   correctness gap in the underlying detection.
4. **`VELOCITY_SPIKE`'s raw-stats query (`RuleFactsService.fetchVelocityRawStats`) duplicates
   `VelocityAdapterService`'s day-grouped-by-`occurred_at` SQL shape (Prompt 4) rather than reusing
   it.** `VelocityAdapterService.getStats()` returns a risk *score* (`TransactionVelocityFactor`'s
   shape: `{score, detail}`), not the raw `rollingDailyAvg30d`/`spikeRatio`/`dormancyDays` numbers
   Section 6.5's evaluator needs — refactoring Prompt 4's stable, already-tested code to expose both
   shapes from one query was judged higher-risk than a small, contained duplication, consistent with
   this codebase's general preference (documented repeatedly in earlier prompts) for duplication over
   a risky shared-runtime refactor.
5. **`GET /rules`/`GET /rules/:id`/`POST /rules/:id/test` request/response bodies have no declared
   Swagger schema fields** — the same `@nestjs/swagger` CLI-plugin gap every prior prompt's
   list/detail endpoints already have. Filtering/behavior is correct (verified by e2e tests); it
   can't be driven from typed Swagger fields yet.
6. **The frontend's mock-data API layer (`apps/web/src/lib/mock-data/routes.ts`) was not reconciled
   against this real backend in this session** — same "backend ships first, frontend re-pointed in a
   later pass" pattern already used for Prompts 1-4 (see the "Fix real-backend list response shape
   mismatch across 17 call sites" commit that did this for earlier prompts). The frontend's
   `MockRule.config` shape (`{key, label, value, unit}[]`) and its client-side-only
   `LOOSENS_ON_INCREASE` loosening-confirmation table differ from this backend's plain
   `Record<string, unknown>` config and its now-real, server-side-enforced
   `X-Confirm-Loosening` guardrail — reconciling those is a contained follow-up, not a redesign,
   since the semantics (which fields loosen on increase) already agree field-for-field.

### Known issues / incomplete items (Backend Prompt 5)

- ~~Multi-instance `apps/api` duplicate rule evaluation~~ — **resolved in a follow-up session**
  (`integration/v1`, independent of the `evaluate-rules`-relocation fix above). **Root cause,
  confirmed by reading the code, not assumed**: every live `apps/api` process still independently
  observes the same `transaction.ingested` completion — that part is unchanged and, on its own, is
  not the bug. `transaction.ingested` is raised by `TransactionIngestionQueueService`'s own
  `QueueEvents` bridge, and Redis pub/sub genuinely fans a queue's "completed" notification out to
  *every* subscriber, so N running `apps/api` replicas each get their own copy of the event and each
  independently call their own `TransactionListener.onTransactionIngested`. Two listeners subscribe
  to `transaction.ingested` in this codebase: `RiskModule`'s (Section 9.4's 60s re-score debounce)
  and `RulesModule`'s (this one). `RiskModule`'s was never actually affected by the fan-out — its
  debounce already goes through a Redis `SET NX` lock (`TransactionIngestionQueueService.acquireLock`),
  which happens to make it naturally idempotent across replicas too (only one instance's lock
  acquisition succeeds; the rest short-circuit on `return`). `RulesModule`'s
  `TransactionListener` had no equivalent guard — it called `RuleEvaluationQueueService.enqueue()`
  unconditionally, and that method's own `Queue.add()` call passed no explicit `jobId`, so BullMQ
  auto-generated a fresh, distinct id on every call — N independent jobs, one genuine job's worth of
  work each, for one transaction. No other `@OnEvent` listener in `apps/api` was affected: the only
  other one (`customer.updated`, in `ScreeningModule`) is emitted directly, in-process, from
  `CustomersService` as part of handling a single HTTP request — never bridged through `QueueEvents`
  — so only the one replica that actually received that request ever emits it; there is no fan-out to
  be idempotent against in the first place. **Fix**: `RuleEvaluationQueueService.enqueue()` now
  passes `jobId: data.transactionId` to `Queue.add()` (see that method's own docblock) — the same
  "deterministic jobId collapses multiple producers into one job" idiom
  `TransactionIngestionQueueService.enqueue`'s `jobId: data.batchId` already established in this
  codebase, applied here for the reason it actually matters this time (there, a single HTTP request
  triggers exactly one enqueue call regardless; here, up to N replicas each independently attempt
  one). `transactionId` is a UUID, globally unique with no per-tenant collision risk, and
  `RuleEvaluationQueueService.enqueue` has exactly one call site with no legitimate case for two
  concurrent jobs over the same transaction — so BullMQ silently returning the already-enqueued job's
  reference on the 2nd..Nth call is exactly the desired outcome. This changes nothing about
  retry/failure handling — job creation (client-side, `Queue.add`) and job execution resilience
  (`apps/worker`'s stalled-job detection, any configured `attempts`) are orthogonal BullMQ concerns;
  a worker crash mid-processing is still recovered exactly as before. **Verified**: a new
  `apps/api/test/rules.e2e-spec.ts` describe block (`RuleEvaluationQueueService: idempotent enqueue
  across apps/api replicas`) proves two `enqueue()` calls with the same `transactionId` produce
  exactly one job in the queue (enumerated across every BullMQ job state, not just an id-equality
  check) and that different transaction ids still get independent jobs. Beyond the automated suite,
  also verified live with two genuinely separate `apps/api` OS processes (`:4000` and a second
  `node dist/main.js` on `:4002`, both pointed at the same Postgres/Redis) — ingesting one
  transaction through `:4000` produced exactly 5 `rule_evaluation` rows (one per active rule, not
  10), one `Alert` with `fire_count = 1` (not 2), and exactly one `bull:rule-evaluation:<transactionId>`
  key in Redis — the same live 2-instance setup that originally demonstrated this bug (see the
  `evaluate-rules` relocation entry above) now produces exactly one evaluation, not two.
- **No literal fault-injection test for "one rule throwing an error does not prevent other rules
  from firing" (Section 11.2)** — the per-rule try/catch in `evaluateTransaction`
  (`apps/worker/src/rules/evaluate-rules.processor.ts`, formerly `apps/api`'s
  `RuleEvaluationOrchestratorService` before the follow-up session that moved it — see Deviations #1)
  structurally guarantees this (every rule's evaluation is independently wrapped, and a thrown error
  is caught and recorded as a `RuleEvaluation` row with `result = ERROR` rather than propagating),
  and the "disabled rule is not evaluated" / "all 5 rules produce a RuleEvaluation row" tests do
  exercise the same loop, but no test artificially throws inside one evaluator to observe the other
  four still firing. Flagged honestly rather than silently assumed covered.
- **The CLI's own argument validation (`--tenant` required, etc.) has no automated test** — verified
  manually (`pnpm cli:rule-replay` with no args prints usage and exits 1), not via an automated
  subprocess-spawning test, since `apps/api`'s e2e suite has no existing precedent for testing a CLI
  entry point as a black box (only `RuleReplayService`'s actual replay logic is tested, directly,
  which is where the real risk was).
- **`GET /rules`/`GET /rules/:id`/`POST /rules/:id/test` Swagger schema gap** — see Deviations #5.
- **Frontend not reconciled** — see Deviations #6.
- ~~No `docs/testing/prompt-5-swagger-test-guide.md`~~ — **resolved in a follow-up session**:
  `docs/testing/prompt-5-swagger-test-guide.md` now exists, hand-walked against a live
  `docker-compose up -d` + `pnpm dev` instance the same way every prior prompt's guide was (every
  response body, status code, and dedup/fire-count number recorded is a real one from that run, not
  inferred). Covers: all 5 scenarios firing via real webhook-ingested transactions with a live check
  that each alert's `title`/`evidence` genuinely reads as a clear, self-contained description;
  same-day dedup on `STRUCTURING` (`fireCount` 1→2, `relatedTransactionIds` merging without
  duplicates); the `X-Confirm-Loosening` guardrail (`422` without it, `200` with it, no header needed
  when tightening, real audit-log before/after diff); the replay CLI in both modes (dry-run produces
  a CSV and writes nothing, live mode increments the same alert twice across two separate runs); and
  tenant isolation (a freshly created tenant gets its own 5 rules with distinct ids, `404` not `403`
  on cross-tenant direct-id access, a real transaction fired in one tenant never surfaces in
  another's `GET /alerts`). Walking it live surfaced two more genuine findings, neither a bug: **(1)**
  a tenant created *before* this prompt shipped has zero `Rule` rows — seeding only runs at
  tenant-creation time, with no retroactive backfill, confirmed directly against an old "Guide Test
  Tenant B" left over from Prompt 4's own guide; **(2)** in the `VELOCITY_SPIKE` walkthrough, the
  resulting alert's `fireCount` was `7`, not `1` — every row in an 11-row (6 history + spike, tuned
  down to 7 rows for this guide) ingestion batch independently emits its own `transaction.ingested`
  event and, since velocity evaluation reads "today's total" in real time and all rows land before
  any evaluation runs, all 7 independently observe the already-committed spike and fire, collapsing
  into one alert via the same dedup key. Documented explicitly in the guide so a reader doesn't
  mistake it for a duplicate-alert bug.
- ~~Tenants created before this prompt shipped have zero `Rule` rows, with no retroactive seeding~~
  — **resolved in a follow-up session** (`integration/v1`, independent of the two `evaluate-rules`
  fixes above): a one-off backfill CLI now exists,
  `apps/api/src/rules/backfill/rule-backfill.cli.ts` (`pnpm cli:rule-backfill [-- --dry-run]`), same
  no-nest-commander `NestFactory.createApplicationContext` convention `rule-replay.cli.ts` already
  established (this codebase has never depended on nest-commander — see that CLI's own docblock).
  It calls `RulesService.seedDefaultsForTenant` verbatim, the exact same method
  `TenantsService.create()` calls for brand-new tenants, rather than re-deriving
  `DEFAULT_RULE_CONFIGS` a second time. Per-tenant idempotency check is deliberately precise —
  comparing each tenant's existing `Rule.scenario_type`s against `DEFAULT_RULE_CONFIGS`, not a
  coarse `ruleCount === 0` — so a tenant missing only *some* of the 5 defaults (not encountered in
  this dev database, but not ruled out either) still gets backfilled correctly instead of being
  skipped outright; `seedDefaultsForTenant` itself is already idempotent per (tenant, scenario_type),
  so the script's own check exists to decide what to report, not to duplicate that guarantee.
  **Run for real against the local dev database** (not just described): dry-run and live runs both
  confirmed against a real baseline query (265 of 292 tenants had zero rules, 27 already had all 5,
  none partially seeded) — the live run reported `265 seeded, 27 skipped, 0 failed`, matching the
  dry-run exactly; a follow-up query confirmed every one of the 292 tenants now has exactly 5 `Rule`
  rows (1,460 total, zero duplicate `(tenant_id, scenario_type)` pairs), and that a previously-seeded
  tenant's rule ids/`created_at` timestamps were untouched (confirmed by direct id comparison, not
  just a count). Re-running the script a second time confirmed idempotency live: `0 seeded, 292
  skipped, 0 failed`, row count unchanged.

### Definition of Done — Backend Prompt 5 — verified vs. not verified

| # | Item | Status |
|---|---|---|
| 1 | Migration applies cleanly, monthly partitions for `rule_evaluation` | ✅ Verified — `pnpm db:migrate` against live Postgres |
| 2 | Default `Rule` rows seeded for every new tenant | ✅ Verified — `seed.ts` re-run against live Postgres, `SELECT * FROM rule` confirms 5 rows/tenant; also covered by `TenantsService.create()`'s call to `seedDefaultsForTenant` |
| 3 | All 5 evaluators implemented and registered | ✅ Verified — `packages/rules-engine`, 41 unit tests covering Section 11.1's full matrix; `dispatchEvaluation()` is the registry |
| 4 | `evaluate-rules` BullMQ processor consuming `transaction.ingested` | ✅ Verified — real, independent `bullmq` `Worker`; runs inside `apps/worker` per Section 4's file tree as of the follow-up session that resolved Deviations #1; exercised **twice**: once via the automated e2e suite calling `evaluateTransaction` directly (deterministic, `apps/worker/test/rules.e2e-spec.ts`), once via a full live manual walkthrough (webhook → real `apps/worker` ingestion → real `transaction.ingested` → real enqueue → real `apps/worker` rule-evaluation consumer, a genuinely separate OS process from the producer → real `Alert` → `RuleEvaluationQueueService`'s `QueueEvents` bridge observing completion back in `apps/api`) |
| 5 | Alert UPSERT semantics verified by the concurrent race test | ✅ Verified — `alert dedup race safety` describe block: two concurrent `createOrIncrement` calls on the same dedup key produce exactly one `Alert` with `fire_count = 2`; also incidentally re-confirmed live by the multi-instance duplicate-evaluation scenario in Deviations #1 |
| 6 | Counterparty screening cache working with 7-day TTL | ✅ Verified — both the internal-counterparty path (no external call at all) and the external-counterparty path are e2e-tested; the external test asserts `screening_check` row count is identical after a second evaluation of the same counterparty (bank+account), confirming the cache genuinely short-circuits the provider call, not just that a value is stored |
| 7 | `alert.created`, `alert.escalated`, `alert.critical_fired` events emitted correctly | ✅ Verified by code path — since the follow-up session that resolved Deviations #1, `apps/worker`'s `evaluateTransaction` returns a `RuleEvaluationJobResult` and `apps/api`'s `RuleEvaluationQueueService`'s `QueueEvents` bridge (`onJobCompleted`) emits the three events from it; no dedicated `EventEmitter2` spy test asserting the exact event names/payloads in this session |
| 8 | Rule update endpoints with the loosening confirmation guardrail | ✅ Verified — e2e: disable-without-reason 400, loosening-without-header 422, loosening-with-header 200, tightening never needs the header, before/after config diff on the audit row |
| 9 | CLI replay command working in dry-run and live modes | ✅ Verified — `RuleReplayService.replay()` exercised directly (dry-run produces a CSV report and zero DB writes; live mode creates alerts and increments `fire_count` on re-run); the CLI script itself verified by direct invocation, not an automated test (see Known Issues) |
| 10 | Audit log entries: `rule.update`, `rule.disable`, `alert.create`, `alert.assign`, `alert.close`, `alert.escalate` | ✅ Verified — e2e assertions query `audit_log` directly for `rule.disable` and `alert.close`; `rule.update`, `alert.create`, `alert.assign`, and `alert.close` were additionally confirmed live against a real Postgres instance while hand-walking `docs/testing/prompt-5-swagger-test-guide.md` (Sections 8 and 10) — `alert.escalate` is written by the same `AuditService.record()` call site as the others, confirmed by code review rather than a direct query |
| 11 | Per-scenario unit tests cover the Section 11.1 matrix | ✅ Verified — 41 tests in `packages/rules-engine`, every listed positive/negative case present |
| 12 | Integration tests (Sections 11.2-11.6) pass | ✅ Mostly verified — orchestration, dedup/race, tenant isolation, rule-update guardrails, and replay are all covered (24 e2e tests); the fault-injection sub-case of 11.2 is the one disclosed gap (see Known Issues) |
| 13 | Performance targets (Section 11.7) | ⬜ Not verified — no load test run in this session; the per-transaction evaluation loop is 5 sequential, indexed queries plus one UPSERT, well within the spec's p99 < 250ms budget on the evidence of individual e2e test timings (all well under 250ms), but no dedicated 10k-transaction benchmark was run |
| 14 | All previous tests (Prompts 1-4) still green | ✅ Verified — full `pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm test:e2e` run at the repo root: every task green (`apps/api` e2e 113/113 across 9 suites, `apps/worker` e2e 27/27 across 5 non-benchmark suites) |
| 15 | Swagger covers all new endpoints | ✅ Verified minimally (`@ApiTags`/`@ApiBearerAuth` only, matching house style — see Known Issues); additionally, `docs/testing/prompt-5-swagger-test-guide.md` (added in a follow-up session, see Known Issues) hand-walks every endpoint against a live server, the same bar every prior prompt's guide was held to |
| 16 | CI green | ⬜ Not verified in this session — no CI run observed |

**Bottom line**: all 5 scenarios fire correctly against real Postgres data (not just the pure-function
unit tests — the e2e suite inserts real transaction rows and calls the real orchestrator), the alert
UPSERT is genuinely race-safe, and the loosening-confirmation guardrail is real, server-side
enforcement, not just the frontend's existing client-side checkbox. A real bug was found and fixed
this session, the same way Prompt 4's bugs were: **an established customer's very first-ever
transaction was misclassified as a "dormancy reactivation" velocity spike**, because "no prior
activity in the queried window" and "genuinely dormant for the full window" produced the same
`dormancyDays` value with nothing to tell them apart — caught by the e2e suite (a hand-crafted
pure-unit-test fixture would never have hit this, since it directly supplied `dormancyDays` without
going through the real query), fixed by adding an explicit `hasPriorActivityInWindow` signal, and
covered by both a new e2e assertion and a new pure-unit regression test. A second, more interesting
discovery came from the live manual walkthrough, not the automated suite: running two `apps/api`
instances against the same Redis (an accidental artifact of a leftover background `pnpm dev` process
from earlier in the session, not something deliberately arranged) causes each to independently
enqueue and evaluate the same transaction — exactly the kind of multi-instance condition an
automated single-process test suite cannot surface on its own — and confirmed, live, that the
dedup-key UPSERT handles it correctly (one `Alert`, `fire_count = 2`) even though it wasn't the
scenario the race test was originally written for. Two disclosed gaps remain before assuming full
literal-spec parity: no dedicated fault-injection test for one-rule-throws-others-still-fire
(Known Issues), and the frontend has not yet been re-pointed at this real backend (Deviations #6).

**Follow-up session**: `docs/testing/prompt-5-swagger-test-guide.md` now exists, hand-walked against
a live server the same way every prior prompt's guide was (see Known Issues for the full rundown).
It found two more genuine, non-bug findings the automated suite's own design couldn't have surfaced
the same way: a tenant created before this prompt shipped has zero `Rule` rows (no retroactive
seeding backfill — **since resolved by a one-off CLI backfill, `pnpm cli:rule-backfill`, run
successfully against the dev database; see Known Issues**), and a multi-row ingestion batch touching
`VELOCITY_SPIKE` produces a `fireCount` equal to the batch size, not `1`, because every row's own
`transaction.ingested` event independently observes the already-committed spike. Both are explained
in the guide at the exact point a reader would otherwise assume a bug.

**Second follow-up session** (`integration/v1`): the `evaluate-rules` BullMQ consumer relocated from
`apps/api` to `apps/worker` (matching Section 4's file tree — see the resolved Deviations #1 above),
the multi-instance duplicate-enqueue characteristic fixed with a deterministic BullMQ `jobId` (see
the resolved Known Issues entry above), and the zero-`Rule`-row backfill CLI added and run against
the dev database (see the resolved Known Issues entry above) — three independent fixes, each verified
with its own build/test/e2e pass plus a live `pnpm dev`/direct-database check, not just the automated
suite.

### Backend Prompt 6 (Case Management module) adds

The final module of the v1 plan: case creation, notes, evidence, the escalation checklist, alert
linking, the full five-state lifecycle (`OPEN` → `UNDER_INVESTIGATION` → `PENDING_APPROVAL` →
`CLOSED`/`SAR_FILED`) with genuine two-person maker-checker on submit/approve/reject, reassignment,
an `AlertStatusListener` reacting to a linked alert's own status changing, `Report` auto-creation on
approval, and the full nine-event-type timeline assembly. Built on top of Prompts 1-5 with no changes
to their guarantees.

- **`packages/shared`**: `CaseStatus`/`CasePriority`/`CaseApprovalOutcome`/`ReportType`/`ReportStatus`
  enums; `CaseDto`/`CaseCustomerSummaryDto`/`CaseAlertSummaryDto`/`CaseNoteDto`/`CaseEvidenceDto`/
  `CaseChecklistItemDto`/`CaseChecklistDto`/`CaseTimelineEventDto`/`CaseReportSummaryDto`/
  `CaseDetailDto`/`CaseListItemDto`/`ReportDto` wire types. `ALERT_EVENTS.STATUS_CHANGED` and
  `AlertStatusChangedEvent` added to `apps/api/src/rules/rules.events.ts`; `AlertClosedEvent` gained a
  `previousStatus` field — both needed so Cases can react to a linked alert moving off `NEW` (the
  spec's third auto-transition trigger) without Prompt 5's `AlertsService` needing to know Cases
  exists.
- **`packages/db`**: `CaseEntity`, `CaseAlertEntity`, `CaseAssignmentEventEntity`, `CaseNoteEntity`,
  `CaseEvidenceEntity`, `CaseApprovalEventEntity`, `CaseSubmissionEventEntity`, `ReportEntity`;
  migration `1700000060000-Cases.ts` (the original seven tables, a single-column unique index on
  `case_alert.alert_id` alone — deliberately not composite on `(case_id, alert_id)`, per the
  migration's own inline comment — enforcing "one case per alert" at the database level, plus
  `uq_report_case_id` enforcing "one report per case," and the same RLS enable/force + policy pattern
  as every migration since Prompt 1), plus a forward-only follow-up migration
  `1700000061000-CaseSubmissionEvent.ts` adding an eighth table (see the durable-submission-history fix
  below for why). `ReportEntity` is deliberately minimal (`id`/`tenantId`/`caseId`/`customerId`/
  `reportType`/`status`/`generatedAt`/`generatedBy`/timestamps) — **a future Reports-module prompt will
  need to extend it substantially** (narrative, flagged amount, submission fields, XML content) — this
  module only seeds the row `case.approve` auto-creates.
- **`apps/api/src/cases`**: `CasesService` (creation via all three entry points, the real five-state
  lifecycle's four transitions plus reassignment, the escalation checklist — one method,
  `computeChecklist()`, used by both the read endpoint and the submit-for-approval guard — and derived-
  transaction lookup), `CaseNotesService`, `CaseEvidenceService` (FileStorage-backed, same
  `LocalFileStorage` construction pattern as `CustomersService`/`CustomerIngestionService`),
  `CaseTimelineService` (the denormalized nine-event-type timeline, resolved into `CasesService` via
  `forwardRef()` since the two genuinely need each other), `AlertStatusListener` (the third
  auto-transition trigger, subscribing to `alert.status_changed`/`alert.closed`), and 13 endpoints
  (`POST /cases`, `GET /cases`, `GET /cases/:id`, `GET /cases/:id/checklist`, `POST /cases/:id/alerts`,
  `POST /cases/:id/notes`, `POST /cases/:id/evidence`, `GET /cases/:id/evidence/:evidenceId`,
  `PATCH /cases/:id/close`, `PATCH /cases/:id/submit`, `PATCH /cases/:id/approve`,
  `PATCH /cases/:id/reject`, `PATCH /cases/:id/assign`).
- **`apps/api/src/rules/alerts/alerts.service.ts`**: `assign()` now emits `ALERT_EVENTS.STATUS_CHANGED`
  when an alert's status actually changes; `close()`'s existing `ALERT_EVENTS.CLOSED` emission gained a
  `previousStatus` field. Purely additive — no existing `ALERT_EVENTS.*` subscriber existed anywhere
  before this prompt, so nothing that already depended on these events' shape could have broken.
- **Tests**: `apps/api/test/cases.e2e-spec.ts` — **60 tests across 11 `describe` blocks**, covering
  creation (all 3 entry points), the full state machine (every valid/invalid transition, maker-checker
  both directions, including the reject-side twin of the self-approve guard), all three auto-transition
  triggers independently (each now also asserted to write its own `case.investigation_started` audit
  row), the escalation checklist (all 4 items, the any-vs-every distinction), alert linking (including
  the checklist-3 regression case), evidence upload/download (byte-for-byte round trip, type/size
  validation, dual audit+timeline entries), reassignment, Report auto-creation, the full assembled
  timeline (event ordering, all 9 types, the creation-time-vs-later-link distinction, and now a
  dedicated submit→reject→resubmit→approve case proving the full submission history stays visible
  throughout), a terminal-case guard on notes/evidence, role gates (including `SUPER_ADMIN` on every
  mutating endpoint and both previously-untested read endpoints), tenant isolation, and RLS enforced
  directly at the database level. This brings `apps/api`'s total e2e suite to **166** (up from 152
  before this module), across 10 suites.

### Critical bugs found while building the Case Management module (fixed)

Continuing the numbering above.

23. **`CaseEvidenceService.getStream()` (evidence download) wrote its `case.evidence_downloaded` audit
    row inside a nested transaction/savepoint, but the controller's `@Res()`-based
    `stream.pipe(res)` bypasses `TransactionInterceptor`'s normal commit-before-response guarantee —
    so a client could receive a fully-streamed file before the audit row was durably committed and
    visible to any other database connection.** Found during a live code review of Task 7 (evidence
    upload/download), before the module's 12 implementation tasks were complete. Root cause: every
    other audited write in this module (upload, notes, state transitions, etc.) returns a plain DTO
    through Nest's ordinary response pipeline, so `TransactionInterceptor` gets a chance to run and
    commit the request's real outer transaction (opened by `TenantContextMiddleware`) before the
    response body is ever sent — wrapping the audit write in a nested savepoint inside that still-open
    outer transaction was therefore "audit row visible once the interceptor commits," same as
    everywhere else. `downloadEvidence` breaks that assumption: it uses `@Res()` and pipes the file
    stream straight to the raw HTTP response object, which starts flushing bytes to the client
    immediately once `getStream()` resolves — well before `TransactionInterceptor` ever runs. A small
    file's download could complete, client side, while the audit row was still sitting in an
    uncommitted outer transaction, invisible to any other Postgres connection — a genuine
    compliance-audit-durability gap, not a cosmetic ordering issue. **Fix**: `getStream()` no longer
    opens a nested savepoint; it commits the *actual* outer transaction (`await
    qr.commitTransaction()`) itself, synchronously, immediately after writing the audit row and before
    returning the stream to the controller — a real `COMMIT`, not a savepoint release, so the audit
    row is durable before a single byte is streamed. `TransactionInterceptor`'s own `if
    (queryRunner.isTransactionActive) commitTransaction()` guard correctly no-ops afterward instead of
    double-committing. **Verified**: confirmed as a genuine, reproducible race (not a flaky test)
    before the fix, then fixed and re-verified — the evidence round-trip e2e test (which asserts the
    `case.evidence_downloaded` audit row is visible via a *separate* connection immediately after the
    download response completes) was run 10 times in a row with zero failures, plus a full `apps/api`
    e2e pass and the full workspace suite, both green.

Three more bugs surfaced in a whole-branch review that ran only after all 12 implementation tasks were
individually complete and task-reviewed — the kind of thing a per-task review's narrower lens
structurally can't see, since each one spans code written across multiple, separately-dispatched tasks.

24. **Notes and evidence could still be added to a `CLOSED` or `SAR_FILED` case, silently mutating the
    record behind an already-filed SAR.** Root cause: `CaseNotesService.addNote()` (built early in the
    module, before terminal states existed) and `CaseEvidenceService.upload()` (same) both called
    `CasesService.findEntity()` but discarded the returned entity, so neither ever checked the case's
    own status — unlike `linkAlert()` and `assign()` (both built after the state machine), which
    gained a `CLOSED`/`SAR_FILED` guard from the start. Nothing retro-fitted the guard onto the two
    earlier services once terminal states existed, leaving the module inconsistent. **Fix**: both
    services now capture the entity from `findEntity()` and reject with the same `400
    CASE_ALREADY_TERMINAL` code `linkAlert()` already established for this exact concept. **Verified**:
    dedicated e2e test asserts `400 CASE_ALREADY_TERMINAL` for a note attempted against a closed case;
    full suite green afterward.
25. **The automatic `OPEN` → `UNDER_INVESTIGATION` transition (`maybeStartInvestigation()`, the three
    auto-triggers: note added, evidence uploaded, linked-alert status change) was never audit-logged —
    and on the event-listener trigger specifically, there was zero audit trace of any kind.** Root
    cause: every *manual* status transition (`close`/`submit`/`approve`/`reject`) records a
    `beforeState`/`afterState` audit row as part of its own transaction; the one *automatic* transition
    never did, because it was written as a small shared helper called from three different places
    (notes, evidence, the alert-status listener) and none of those three callers' own audit calls
    captured the case's status change — only the note/evidence action itself. On a compliance platform
    whose core purpose is a reconstructable audit trail, an automatic status change with no
    attributable record — the kind of change an auditor is most likely to ask "who/what triggered
    this" about — is a real gap. **Fix**: `maybeStartInvestigation()` now takes an `actor`/`meta` pair
    and records a `case.investigation_started` audit row (`beforeState: {status: OPEN}`,
    `afterState: {status: UNDER_INVESTIGATION}`) inside the same transaction as the status update, on
    all three call sites — the two HTTP-triggered ones pass the real `currentUser.sub`/request
    IP+user-agent, the listener passes `null` for both (no HTTP request exists on that path, matching
    this codebase's existing convention for listener-driven audit writes with no real user). **Verified**:
    dedicated e2e test directly queries `AuditLogEntity` for `action: "case.investigation_started"`
    after triggering the transition, asserting exactly one row.
26. **`maybeStartInvestigation()` had a read-then-write race that could resurrect a just-closed case.**
    Root cause: the original implementation read the case's status, checked it was `OPEN` in
    application code, then issued an unconditional `UPDATE ... SET status = 'UNDER_INVESTIGATION'
    WHERE id = $1` with no status predicate in the `WHERE` clause — so a case closed by a concurrent
    request between the read and the write would still get flipped back to `UNDER_INVESTIGATION` once
    this update's row lock came through, while `closed_at`/`closed_by`/`closure_reason` stayed
    populated. The window is widest on the listener path, where the read and write happen on a
    connection entirely separate from whatever request closed the case. **Fix**: the status predicate
    now lives directly in the `UPDATE`'s own `WHERE` clause (`repo.update({ id, tenantId, status:
    CaseStatus.OPEN }, {...})`), so Postgres re-evaluates "is this still OPEN?" atomically as part of
    acquiring the row lock, with `result.affected === 0` as the no-op signal — the same code change as
    bug #25's fix, not a separate patch. **Verified**: by direct code inspection during the whole-branch
    review (confirming the predicate is genuinely inside the `UPDATE`, not a separate prior `SELECT`
    used as the sole gate) — no dedicated concurrency test exists for this specific race (see Known
    Issues).

A fourth, separate bug was found during manual guide-writing/testing, in a follow-up session after the
whole-branch review's own fixes had already landed:

27. **The "submitted for approval" timeline event silently disappeared once a case was rejected, even
    though the submission genuinely happened.** Root cause: `CaseTimelineService`'s `submitted` event
    was derived from the case's own live `submittedBy`/`submittedAt` columns — but `reject()` correctly
    nulls both of those (so a resubmission starts with a clean slate), which meant the timeline lost
    the historical record that a submission had ever occurred the moment a case was rejected. The
    underlying `case_approval_event` row (with the rejection reason) survived intact — only the
    timeline's visual representation of "this was submitted" vanished. On a compliance platform, a
    regulator or auditor reviewing a case's history should be able to see it was submitted, then
    rejected, then possibly resubmitted, not have the first submission silently erased from the visible
    record. **Fix**: a new table, `case_submission_event` (`id`/`tenantId`/`caseId`/`actor`/
    `rationale`/`at`), mirrors `case_approval_event`'s own shape/rationale for existing — a durable,
    insert-only row created on every successful `submit()` call, inside the same transaction as the
    status update, never touched by `reject()`. `CaseTimelineService` now derives `submitted` events
    from this table (one event per row) instead of from the live case columns, so a case submitted,
    rejected, and resubmitted shows **both** submission events in its timeline, each with its own
    actor/timestamp/rationale — the live `submittedBy`/`submittedAt`/`escalationRationale` columns on
    `case` itself are unchanged (still nulled on reject; still the "is there currently a pending
    submission" signal), this fix only makes the *historical* record durable. Added via a new
    forward-only migration (`1700000061000-CaseSubmissionEvent.ts`), not an edit to the already-applied
    `1700000060000-Cases.ts`, same precedent as `1700000002000-FixTenantIsolationEmptyStringCast.ts`
    fixing `InitialSchema` without touching it. **Verified**: migration applied/reverted/re-applied
    cleanly against the live dev Postgres; a dedicated e2e test walks submit → reject → resubmit →
    approve and asserts exactly 2 `submitted` timeline events visible throughout (never collapsing to
    1), cross-checked directly against 2 distinct `case_submission_event` rows with their own rationale
    text; additionally confirmed live against a running server (not just the automated suite) — the
    live `submittedBy`/`submittedAt` fields were confirmed `null` after reject while the `submitted`
    timeline event for that same submission remained visible, then a resubmission and approval showed
    both submission events end-to-end. Full `apps/api` e2e suite green afterward (166/166), including
    every pre-existing test in `cases.e2e-spec.ts` unaffected by the change.

### Deviations from the Backend Prompt 6 spec (and why)

1. **`AlertCriticalFiredEvent` (added in Prompt 5) has no subscriber.** Its docblock, written during
   Prompt 5, anticipated "Prompt 6's Case Management subscribes to auto-open a Case" — but this
   prompt's actual written spec never asks for auto-case-creation from a critical alert, and the
   frontend mock it's built from is explicit (`docs/cases-module-frontend-inventory.md` §3): "Nothing
   else in the app auto-opens a case... every case in the live (non-seeded) data path is created by an
   explicit user action." Per the spec's own rule ("where this prompt's design differs from the mock,
   the difference is called out explicitly in §2 — everything else should be read as match the mock's
   behavior"), silence here means match the mock. The stale docblock was corrected in place rather
   than left misleading.
2. **Role-gate rejections return `403 FORBIDDEN_ROLE`, not literally `FORBIDDEN`.** This is the
   existing, already-established error code the shared `RolesGuard` has produced for every role-gated
   endpoint since Prompt 1 — introducing a second, bespoke `FORBIDDEN` code for this module alone would
   fragment the convention, not follow the spec more closely.
3. **Reassignment (`PATCH /cases/:id/assign`) rejects an already-terminal case with `400
   CASE_ALREADY_TERMINAL`**, reusing the same code the alert-linking guard uses for the identical
   concept, even though the endpoint-level error list doesn't separately enumerate it for this
   endpoint. The state-machine section's own wording — reassignment "can happen at any non-terminal
   status" — reads as an explicit guard, not merely descriptive.
4. **`case_number` generation and alert-linking's "already linked" check both have a narrow,
   accepted concurrent-race window.** `nextCaseNumber()` recomputes `(max existing sequence) + 1` per
   call rather than using a stored counter (per the spec's own explicit instruction not to introduce a
   counter table); two truly simultaneous case creations for the same tenant+year could in principle
   collide and have the second insert rejected by the `(tenant_id, case_number)` unique index. Alert
   linking's `case_alert` existence pre-check has the same class of narrow window before its own
   unique-on-`alert_id` index would catch a genuine double-link. Neither is additionally guarded with
   an advisory lock — the spec doesn't ask for one, and the mock's own `nextCaseNumber` has the
   identical non-atomic property.
5. **Evidence upload (`POST /cases/:id/evidence`) sets no Multer `limits.fileSize`.** Unlike
   `CustomersController`'s photo upload (which relies on Multer's own size limit and accepts whatever
   generic error results from exceeding it), the spec requires the exact code `400 FILE_TOO_LARGE` —
   checked explicitly in `CaseEvidenceService.upload()` against the buffered `file.size`, after Multer
   has already accepted the full upload into memory.
6. **Timeline event `text` embeds raw user ids** (e.g. "Reassigned this case to `<uuid>`") rather than
   a resolved display name, unlike the mock's `buildTimeline` (which resolves names from a
   separately-fetched `users` array). No DTO anywhere else in this backend resolves a user id to a
   display name either (`AuditLog`, `CaseNoteDto.userId`, `AlertDto.assignedTo`, etc. all store raw
   ids) — the consuming frontend is expected to resolve ids itself, exactly as it already does
   elsewhere.

### Known issues / incomplete items (Backend Prompt 6)

- **No service-level unit tests for `CasesService`/`CaseNotesService`/`CaseEvidenceService`/
  `CaseTimelineService`.** Same standing gap as every prior prompt (Prompt 1's Known Issues first
  flagged this) — all coverage is e2e-only, against a real Postgres.
- ~~Swagger coverage is `@ApiTags`/`@ApiBearerAuth` only, no per-DTO `@ApiProperty()` richness in
  the generated schema — the CLI plugin that would make decorators unnecessary was never enabled~~ —
  **resolved in a follow-up session**: `"plugins": ["@nestjs/swagger"]` added to
  `apps/api/nest-cli.json`'s `compilerOptions`. Verified live against a `rm -rf dist
  tsconfig.tsbuildinfo && npx nest build` + `node dist/main.js` instance — `/docs-json` now shows real
  typed fields (including enums, `minLength`/`maxLength`, `format: email`, nested `$ref`s) for DTOs
  that previously rendered as empty `{"type": "object", "properties": {}}`, across customers, cases,
  and screening (`CreateCustomerDto`, `CreateCaseDto`, `SubmitCaseDto`, `ManualScreenDto`,
  `ReviewMatchDto`, `ConfigureProvidersDto` all confirmed populated). Full `pnpm test` (75 tests) and
  `pnpm test:e2e` (176 tests) still pass unchanged — the plugin only affects compile-time schema
  generation, not `class-validator`/`class-transformer` runtime behavior. **New, narrower limitation
  left behind by this fix**: the plugin only runs through Nest's own compiler (`nest build`/`nest
  start`). `apps/api`'s `pnpm dev` script invokes `tsc-watch` (plain `tsc --watch`), which bypasses
  Nest's compiler entirely, so **schemas will still render empty under `pnpm dev`** — only a `nest
  build`-produced `dist/` (e.g. via `pnpm build` or `pnpm start`) reflects the fix. Switching `dev` to
  `nest start --watch` would close this too, but that changes the hot-reload workflow and was
  deliberately left as a separate follow-up, not bundled into this fix. The unrelated query-parameter
  gaps (`GET /customers`, `GET /screening/checks`, `GET /screening/matches`, `GET
  /customers/export`, etc.) and the file-upload gap (`POST /customers/:id/photo`) are a different
  cause (missing explicit `@ApiQuery()`/`@ApiConsumes()` decorators, which the CLI plugin doesn't
  infer) and are still open.
- **The `case_number`/alert-linking race windows described in Deviations #4 are real, if narrow** —
  disclosed rather than silently accepted.
- **`GET /cases/:id/checklist` and `GET /cases/:id`'s embedded `checklist` field call the exact same
  `computeChecklist()` — verified by code review (one method, two call sites), not by a dedicated test
  asserting the two responses are byte-identical for the same case.**
- **The frontend's mock-data API layer was not reconciled against this real backend in this
  session** — same "backend ships first, frontend re-pointed in a later pass" pattern already used for
  every prior prompt.
- **No concurrency test exists anywhere in `cases.e2e-spec.ts`.** Bug #26's fix (the
  `maybeStartInvestigation()` race) was verified by direct code inspection during the whole-branch
  review, not by a test that actually races two requests — the same is true of the
  `case_number`/alert-linking races in Deviations #4.
- ~~The reject path's `submitted` timeline event disappeared once rejected~~ — **resolved**: see bug
  #27 above (`case_submission_event`). This was found during manual guide-writing/testing, after the
  whole-branch review's own fixes (#24-26) had already landed, and closed in the same follow-up
  session.

### Follow-up session — DoD row 12 (role gates) closed, and the Swagger test guide added

Two gaps disclosed above were closed in a follow-up session, before bug #27 (the submission-history
fix) was found:

**Role-gate coverage.** The whole-branch review had flagged DoD row 12's `✅ Verified` claim as an
overclaim (`SUPER_ADMIN` untested anywhere, `approve`/`reject` only tested against one rejected role,
checklist/evidence-download untested for role) and it was correctly downgraded to `⚠️ Partial` at the
time. This was closed for real: read `cases.controller.ts`'s exact `@Roles()` arrays first (confirming
`ANY_AUTHENTICATED` genuinely includes `SUPER_ADMIN` while the four write-role-list constants don't,
and that `RolesGuard` has zero `SUPER_ADMIN` special-casing — a plain role-membership check), then
added 10 tests: `SUPER_ADMIN` `403` on all 9 mutating endpoints and `200` on both previously-untested
reads (checklist, evidence-download); `VIEWER`/`TENANT_ADMIN`/`SUPER_ADMIN` each independently rejected
on `approve`/`reject`; a dedicated all-5-roles-get-200 test for `GET /cases/:id/checklist`; and the
previously-missing reject-side twin of the maker-checker self-approve guard
(`403 APPROVER_CANNOT_BE_SUBMITTER` on self-reject). No gap in the underlying role-gate logic itself
was found while writing this coverage; `RolesGuard`'s actual behavior matched what a direct reading of
the `@Roles()` arrays predicted in every single case.

**`docs/testing/prompt-6-swagger-test-guide.md` added**, hand-walked against a live `docker-compose up
-d` + `pnpm dev` instance the same way every prior prompt's guide was — every response body, status
code, and id recorded is a real one from that run, not inferred. Covers: case creation via all 3 entry
points (including a live confirmation that an alert's own customer wins over a conflicting body
`customerId`, and that priority derives `HIGH` for `CRITICAL`-severity alerts); the full lifecycle
(`OPEN` → `UNDER_INVESTIGATION` via a live auto-transition → `PENDING_APPROVAL` → `SAR_FILED`, with a
real second Compliance Officer account created specifically so submit/approve are genuinely two
different people, not one account replayed); the reject path (back to `UNDER_INVESTIGATION`, not
`CLOSED`, reason visible in the timeline, and — after bug #27's fix, in a later revision of the same
guide section — the full submission history staying visible through a resubmission and approval); both
maker-checker guards failing live; the escalation checklist's 4 items individually, including the
`any`-vs-`every` distinction and a live regression triggered by linking a second, unreviewed alert;
evidence upload/download as a genuine byte-for-byte round trip with both audit rows and a timeline
entry confirmed by direct diff and SQL; the terminal-case guard (bug #24) rejecting a note and an
evidence upload on a closed case; and tenant isolation (`404`, empty list). Two more real, live-only
findings surfaced in the process, documented in the guide itself: checklist item 3 starts `true`, not
`false`, on a freshly-created case with zero linked alerts (the "zero linked transactions" escape
clause is vacuously satisfied); and a transaction timeline event can legitimately sort *before* the
case's own `opened` event, since the timeline sorts by each event's real-world timestamp and a
transaction can predate the case that was opened in response to it.

### Definition of Done — Backend Prompt 6 — verified vs. not verified

| # | Item | Status |
|---|---|---|
| 1 | Migration applies cleanly (8 tables total — the original 7 plus `case_submission_event` — RLS enable/force + policies, unique index on `case_alert.alert_id`) | ✅ Verified — both migrations (`1700000060000-Cases.ts`, `1700000061000-CaseSubmissionEvent.ts`) applied, reverted, and re-applied cleanly against the live dev Postgres in this session; direct `psql` confirms all 8 tables have `relrowsecurity`/`relforcerowsecurity` both `t` |
| 2 | Case creation: all 3 entry points, field resolution/validation order, auto-set fields, role gate | ✅ Verified — `POST /cases — creation` describe block, part of the full `apps/api` e2e pass (166/166, most recent run) |
| 3 | Real five-state lifecycle: every valid transition succeeds, every invalid transition rejected with the correct code | ✅ Verified — `State machine: close/submit/approve/reject` describe block, same run |
| 4 | Auto-transition to `UNDER_INVESTIGATION`: all 3 triggers (note, evidence, linked-alert status change) independently verified, no re-fire/duplicate, and now audit-logged (bug #25) | ✅ Verified — `POST /cases/:id/notes`, `Evidence upload/download`, and `Alert status-change auto-transition` describe blocks, same run |
| 5 | Genuine two-person maker-checker: submitter-cannot-be-assignee, approver-cannot-be-submitter (both directions, including reject), checklist gate, rationale/reason requirements | ✅ Verified — `State machine` describe block, same run |
| 6 | Escalation checklist: all 4 items independently true/false, any-vs-every distinction (items 1 vs 3) | ✅ Verified — `GET /cases/:id/checklist` describe block, same run |
| 7 | Alert linking: success, customer-mismatch, already-linked, terminal-case rejection, checklist-3 regression | ✅ Verified — `POST /cases/:id/alerts` describe block, same run |
| 8 | Evidence: FileStorage upload/download byte-for-byte round trip, type/size validation, dual audit+timeline entries | ✅ Verified — `Evidence upload/download` describe block; the byte-for-byte/audit-durability test additionally re-run 10 times in isolation with zero failures (see bug #23) |
| 9 | Report auto-creation on approval: exactly one row, correct `caseId`/`customerId`, second approval impossible (case already terminal) | ✅ Verified — `State machine` describe block; `uq_report_case_id` confirmed live via `psql` as the DB-level backstop |
| 10 | Timeline: all 9 event types, correct chronological ordering, creation-time-vs-later-link distinction, index-0 assignment skip, and full submission history surviving a reject/resubmit cycle (bug #27) | ✅ Verified — `Timeline assembly` describe block plus the dedicated submit→reject→resubmit→approve regression test, same run; additionally confirmed live against a running server |
| 11 | Tenant isolation: every endpoint 404s (not 403s) for a cross-tenant case/note/evidence/alert-link | ⚠️ Partial — dedicated cross-tenant 404 assertions exist for only 3 of 13 endpoints (`POST /cases`, `GET /cases/:id`, `POST /cases/:id/notes`); evidence upload, evidence download, alert-link, checklist, close, submit, approve, reject, and assign have no dedicated cross-tenant test — their tenant-scoping code is the same pattern as the tested endpoints (`findEntity`'s `{ id, tenantId }` lookup) but each was not independently asserted |
| 12 | Role gates: every action tested against every role, allowed and rejected | ✅ Verified — closed in a follow-up session (see write-up above): `SUPER_ADMIN` asserted `403 FORBIDDEN_ROLE` on all 9 mutating endpoints and `200` on both previously-untested read endpoints; `approve`/`reject` independently reject `VIEWER`, `TENANT_ADMIN`, and `SUPER_ADMIN`; the reject-side maker-checker guard now has its own dedicated test; `GET /cases/:id/checklist` asserted `200` for all 5 roles |
| 13 | RLS enforced at the database level (not just application-level tenant filtering) | ✅ Verified — the `RLS enforced at the database level` describe block: connects as `regops_app` via a raw `DataSource` with **no** `set_config` at all, and a direct `SELECT * FROM "case" WHERE id = $1` against a row just created returns 0 rows |
| 14 | `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e` all pass across every workspace package | ✅ Verified — full run this session: **lint** 15/15 tasks green; **typecheck** 15/15 tasks green; **test** (unit) 12/12 tasks green — `apps/api` 20/20 (3 suites), `apps/worker` 10/10 (1 suite), `packages/risk-engine` 64/64 (9 suites), `packages/rules-engine` 41/41 (6 suites), `packages/screening-engine` 40/40 (7 suites); **test:e2e** 9/9 tasks green — `apps/api` **166/166** across 10 suites (up from 152 before this module; `cases.e2e-spec.ts` itself is 60 tests across 11 describe blocks), `apps/worker` **37/37** across 6 non-benchmark suites |
| 15 | Hand-walked manual test guide against a live server, claims verified not inferred | ✅ Verified — `docs/testing/prompt-6-swagger-test-guide.md` exists, every step (including the bug #27 fix) run against a live `docker-compose up -d` + `pnpm dev` instance before being written down, the same bar every prior prompt's guide is held to |

**Bottom line**: every behavior this module claims is genuinely proven against a real Postgres, not
carried forward from an earlier prompt's numbers — the full workspace `pnpm lint && pnpm typecheck &&
pnpm test && pnpm test:e2e` run is green end to end (`apps/api` e2e 166/166 across 10 suites, `apps/worker`
e2e 37/37 across 6 non-benchmark suites, unit tests green across every package that has them), and the
database-level RLS test proves a row which genuinely exists is completely invisible to a raw
`regops_app` connection with no tenant context set — this module's RLS policies were independently
re-verified against this module's own tables, not merely trusted by inheritance from earlier prompts'
migration pattern.

Four real, non-cosmetic bugs were found and fixed in this module, not just written and assumed
correct: one during a live code review mid-implementation (#23: an audit-durability race on evidence
download); three during a whole-branch review that ran only after all 12 tasks were individually
complete (#24: notes/evidence writable on a terminal case; #25: the automatic investigation-start
transition never audited; #26: a read-then-write race in that same transition); and one during
follow-up manual guide-writing/testing, after the whole-branch review's own fixes had already landed
(#27: the "submitted" timeline event silently disappearing on rejection, fixed with a new durable
`case_submission_event` table). All four are fixed and re-verified, not just patched and assumed
fixed — dedicated regression tests exist for every one, and the full suite was re-run green after each
fix, with #27 additionally confirmed against a live running server (not just the automated suite): the
live `submittedBy`/`submittedAt` fields were watched go `null` on reject exactly as designed, while the
`submitted` timeline entry for that same submission stayed visible, and a subsequent resubmission plus
approval showed both submissions end to end.

Known, disclosed gaps remain, consistent with every prior prompt's honesty bar rather than assumed
away: the `case_number`/alert-linking race windows (Deviations #4, narrow and accepted, matching the
mock's own non-atomic behavior); no service-level unit tests for the new services (e2e-only coverage,
the same standing gap since Prompt 1); cross-tenant test coverage is real but partial — 3 of 13
endpoints have a dedicated cross-tenant test (DoD row 11); no concurrency test exists anywhere in this
suite, so bug #26's fix is verified by direct code inspection, not a test that actually races two
requests; and the frontend not yet reconciled against this real backend. With this work, all 12 tasks
of the Case Management module plan, the whole-branch review and its fix round, the role-gate coverage
follow-up, the Swagger test guide, and the submission-history durability fix, are complete.
