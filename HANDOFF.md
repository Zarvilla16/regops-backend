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
