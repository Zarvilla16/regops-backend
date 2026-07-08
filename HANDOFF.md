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
