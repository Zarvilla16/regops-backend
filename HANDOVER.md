# RegOps — Handover

Written for whoever is running this project without the previous owner available for the next
few weeks. Start here. `OVERNIGHT_LOG.md` (repo root) has the play-by-play for one specific
overnight session (2026-09-30) if you need forensic detail on any change below — this document
is the current-state summary.

## What RegOps is

RegOps is a multi-tenant AML/CFT (anti-money-laundering / counter-terrorist-financing) compliance
platform for Nigerian microfinance banks, fintechs, PSPs and mobile money operators, built to the
CBN Circular BSD/DIR/PUB/LAB/019/002 baseline standards. It ingests customer and transaction data,
screens customers against sanctions/PEP lists, scores customer risk, runs rule-based transaction
monitoring to raise alerts, lets compliance staff investigate those alerts as Cases, and generates
the two regulatory filings CBN/NFIU require (SARs for suspicious activity, CTRs for large cash
transactions). It's a monorepo: a NestJS API, a BullMQ worker for async jobs, and a Next.js
console, backed by Postgres with row-level security enforcing tenant isolation at the database
layer.

**Note on `README.md`:** the root README is stale — it still describes "Phase 0" as if customer,
screening, transaction, rules, case and reporting modules don't exist yet. They do; all of it is
built (see the module table below). Treat this document as the current source of truth, not the
README, until someone updates it.

## Module status

| Module | Status | Notes |
|---|---|---|
| Auth / Tenants / Users | ✅ Complete & verified | JWT + TOTP MFA, RLS-enforced tenant isolation, audit-atomicity. Full flow verified live. Coverage gap: no service-level unit tests (e2e-only). |
| Customers (+ enhancements) | ✅ Complete & verified | CRUD, PII mask/unmask (role-gated, reason-required), CSV ingestion (100,000-row benchmark passes), photo upload, PEP approval, CSV export — all verified live. Swagger param/schema gaps are cosmetic. |
| Risk Scoring | ✅ Complete & verified | 6-factor engine, banding, PEP/sanctions override, 100% unit coverage. Coverage gap: the `@Cron` schedules' actual firing hasn't been observed live (the logic they call is tested directly). |
| Screening | ⚠️ Complete, coverage gaps | Sync sanctions-block and async PEP/adverse-media flows verified end-to-end. **Real gap:** the scheduled re-screening *producer* (`RescreenSchedulerService`/`RescreenQueueService`) has zero test coverage at any level — only the downstream dequeue side is tested. Real Smile ID / Prembly response-shape mapping is unverified against real provider sandboxes (no network access in the dev environment). |
| Transactions | ✅ Complete & verified | Both ingestion paths (SFTP + webhook), RLS-partitioned store, velocity risk factor verified twice. No `buffer` unknown-customer-resolution mode (only `reject`/`auto_create_stub`). |
| Rules Engine & Alerts | ✅ Complete & verified | All 5 scenarios verified against real Postgres; a real multi-instance duplicate-evaluation race was found and fixed. Coverage gap: no fault-injection test proving one erroring rule doesn't block the others (structurally guaranteed, not test-proven). |
| Case Management | ✅ Complete & verified | Full lifecycle, maker-checker, role gates all verified live. Real gap: no concurrency test races two simultaneous requests anywhere in the suite. |
| Reports (SAR/CTR) | ⚠️ Partial — hard blocker | Generation, maker-checker, exports, role gates all verified. **Hard blocker: the generated XML is not goAML-schema-valid.** It is not implemented against NFIU's real XSD, and is missing fuller institution/officer identifiers and typology/indicator codes. Do not file it with the regulator as-is. |
| Frontend (apps/web) | ✅ Reconciled | Alerts/Cases/Transactions/Rules were reconciled to the real backend DTOs in an earlier session; Reports was reconciled tonight (2026-09-30, see below). Any older note in `HANDOFF.md` about Cases/Rules/Reports frontend pages "not yet reconciled" is now stale. |

## What changed overnight (2026-09-30) and how to verify it

Full detail and judgment calls are in `OVERNIGHT_LOG.md`. Summary:

1. **Reports mock-mode fix** — `apps/web`'s mock layer (`NEXT_PUBLIC_USE_MOCK_DATA=true`) now emits
   the real `ReportDto`/`ReportDetailDto` shapes for the Reports pages, matching the fix already
   done for Alerts/Cases/Transactions/Rules. Verify: `npx tsc --noEmit` and `pnpm lint` both pass;
   backend test suite (153 tests) unaffected. **Not verified: actual browser behavior in mock
   mode** — click through `/reports` and `/reports/:id` (submit → confirm dialogs, XML/CSV/PDF
   export) before treating this as demo-ready.
2. **Repo-split investigation (physical restructure still not performed)** — confirmed `apps/web`
   has no dependency, in either direction, on the backend engine packages or `apps/api`/`apps/worker`.
   The shared-types question this raised has since been decided and partly implemented — see
   "Decisions made" below — but the actual directory-level split (two independently-buildable
   areas, two lockfiles) still hasn't happened.
3. **Next.js ESLint plugin fixed** — `apps/web` now has `@next/eslint-plugin-next` wired in;
   the "Next.js plugin was not detected" build warning is gone. Verify: `pnpm build` in `apps/web`,
   no such warning in the output.
4. **Husky pre-commit hook added** — every commit now runs `pnpm lint` (the whole monorepo) via
   `.husky/pre-commit`, and a failure blocks the commit. Verified live (deliberately broke lint,
   confirmed the commit was rejected).
5. **CI: dead workflow file deleted.** `.github/workflows/ci.yml` had a correctly-written lint step
   already, but could never run on this GitLab-hosted repo — see "Decisions made" below. It's been
   deleted rather than left as misleading dead weight. **CI does not exist for this project right
   now** — a real `.gitlab-ci.yml` still needs to be written.

## Decisions made (resolved 2026-09-30, after this document's first draft)

Both items below were originally logged as open questions for you; you decided both before ending
the session. Recorded here as resolved, with what was actually done and what's still left to do.

### 1. Shared types: `@regops/shared` becomes an externally-consumed package, never duplicated

**Decision:** publish `packages/shared` as its own independent package that `apps/web` depends on
externally — no copying/duplicating its types into the frontend, ever (this exact pattern —
frontend and backend silently drifting on DTO shape — is what broke Alerts/Cases/Transactions/
Rules/Reports earlier and took real sessions to fix each time). If a real private npm registry
isn't feasible immediately, use a git dependency as a documented interim step.

**What's done:**
- `packages/shared/package.json`: removed `"private": true` (a real publish target can't carry
  that), added `files`/`repository` fields for eventual real publishing.
- `packages/shared/dist/` is now committed (a scoped exception in `.gitignore` — see the comment
  there) so a git-dependency install has something to consume with **no build step required on
  install** — this specifically sidesteps a real problem: `packages/shared`'s only devDependency,
  `@regops/config` (`workspace:*`), cannot resolve outside this pnpm workspace, so any install
  path that tried to run a build/`prepare` step for an external consumer would fail. Shipping
  pre-built `dist/` avoids needing that dependency to resolve at all for a git install.
- **Tested and confirmed working** (not just theorized): cloned this repo into a local bare git
  repo and ran `pnpm install` against
  `git+file://<local-bare-repo>#overnight/2026-09-30&path:packages/shared` from a scratch test
  package — it resolved, installed, and both the runtime export (`ReportStatus.SUBMITTED`) and the
  `package.json` fields came through correctly. This confirms pnpm's `#<ref>&path:<subdir>` git
  syntax is the right mechanism and that this package is genuinely ready for it.

**What's still open — exact next steps for whoever does this:**
1. Push this branch (or merge it) to the real remote, so a real ref exists to point at:
   `git push origin overnight/2026-09-30` (or merge to `integration/v1`/`master` first — your
   call, this wasn't done tonight per the "never push" rule this session was given).
2. In `apps/web/package.json`, change `"@regops/shared": "workspace:*"` to:
   `"@regops/shared": "git+https://gitlab.com/Daviking95/regops.git#<branch-or-commit>&path:packages/shared"`
   (use a specific commit SHA once this stabilizes, not a moving branch name, so installs are
   reproducible).
3. Run `pnpm install` at the root, verify `apps/web` still typechecks/builds/lints, commit the
   updated `pnpm-lock.yaml`.
4. **This is still an interim step, not the end state.** `packages/shared/dist/` must be manually
   kept in sync with `src/` (rebuild-and-recommit) until real publishing replaces this — nothing
   enforces that yet. **TODO for real publishing**: set up a private registry (npm's private
   packages, GitHub Packages, or GitLab's own package registry since the repo is already there),
   add a real `publish` step/CI job that runs on a version bump, and only then can step 2 above
   change to a normal versioned semver dependency instead of a git URL.

### 2. CI: the dead GitHub Actions workflow has been deleted

**Decision:** delete `.github/workflows/ci.yml` rather than leave it in place — it could never run
on this GitLab-hosted repo (confirmed: `origin` is `https://gitlab.com/Daviking95/regops.git`), and
a workflow file that looks wired up but silently can't fire is actively misleading to anyone who
finds it later and assumes CI exists.

**What's done:** the file is deleted (`.github/` no longer exists in this repo).

**What's still open — stated plainly:** **CI genuinely does not exist for this project right now.**
Nothing runs lint/typecheck/test/build automatically on push or merge request. A real
`.gitlab-ci.yml` needs to be written from scratch — it was **not** attempted tonight, per explicit
instruction. The old workflow's job structure (a `[lint, typecheck, test, build]` matrix, Postgres +
Redis services, `pnpm install --frozen-lockfile`, migrations before test/build) is a reasonable
reference for what the new file needs to cover, but GitLab CI's YAML shape (`stages:`, `services:`,
`script:`) is different enough from GitHub Actions that it's a genuine rewrite, not a port.

## Still open — not a decision, a real gap

- **The Reports XML is not goAML-schema-valid** (see module table above) — this blocks any real
  NFIU filing. Needs a dedicated pass against the actual XSD before Reports can be considered
  production-ready, not just demo-ready.

## Known issues (consolidated from `HANDOFF.md`, module by module)

**Cross-cutting**
- Most NestJS services (Auth, Users, Tenants, Customers, Cases, Screening, Reports, etc.) have no
  service-level unit tests — coverage is e2e-only. Not a correctness gap (e2e passes), but there's
  no fast, DB-less regression signal when someone touches service logic.
- Several list endpoints (`GET /customers`, `/screening/checks`, `/screening/matches`,
  `/customers/export`, `/transactions`, `/rules`) have no query params declared in Swagger, and a
  few request-body DTOs render as an empty `{}` schema there. Filtering/validation itself works
  (verified by e2e tests and manual curl); this is purely a Swagger discoverability gap.
- `POST /customers/:id/photo`'s file-upload field is similarly missing from Swagger.

**Screening**
- Real gap: the scheduled re-screening *producer* has zero test coverage at any level (see module
  table above).
- Real Smile ID / Prembly response-shape mapping is unverified against real provider sandboxes.

**Transactions**
- The in-memory `insertedTransactions` array during CSV ingestion is unbounded — fine at pilot
  scale, a scaling risk at very large SFTP batches.
- No `buffer` unknown-customer-resolution mode, only `reject`/`auto_create_stub`.

**Rules Engine & Alerts**
- No fault-injection test proving one erroring rule doesn't block the others' evaluation.
- CLI arg validation for the rules seeding/management scripts is verified manually, not by an
  automated test.

**Case Management**
- No concurrency test anywhere in the suite races two simultaneous requests against the same case.
- Minor coupling: the Reports controller imports some shared constants from `cases.controller.ts`.

**Reports — the section with the most open items**
- **Hard blocker**: XML is not goAML-schema-valid (see above) — missing NFIU XSD validation,
  fuller institution/officer identifiers, and typology/indicator codes.
- No correction/amendment workflow for an already-`SUBMITTED` report (out of scope by design, not
  an oversight).
- No reconciliation/backfill mechanism if the API is down when a qualifying cash transaction is
  ingested (a CTR that should have auto-generated silently doesn't).
- Foreign-currency cash transactions never produce a CTR — NGN-only in this version.
- Generated PDFs lose diacritics on non-Latin-1 customer names (a Helvetica font limitation).
- No concurrent-request test for submit/confirm/reject — sequential-only.
- No hand-walked Swagger test guide for the Reports module (every earlier module has one).

## Running it locally

```bash
git clone <this-repo> regops && cd regops
pnpm install

cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
cp apps/worker/.env.example apps/worker/.env
# Edit apps/api/.env: JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must each be a
# distinct random string of 64+ characters, e.g.: openssl rand -hex 64

docker-compose up -d      # postgres :5433, redis :6379, mailhog :8025 (UI at :8025)
pnpm build                # compiles packages/shared and packages/db first
pnpm db:migrate           # applies schema + RLS policies
pnpm db:seed              # creates the seeded accounts below

pnpm dev                  # api :4000, web :3000, worker :4001
```

Open http://localhost:3000. Swagger API docs are at http://localhost:4000/docs.

Everyday commands: `pnpm lint` / `pnpm typecheck` / `pnpm test` (no DB needed) / `pnpm test:e2e`
(needs `docker-compose up` + migrations) / `pnpm build`, all via Turborepo across every package.
Pre-commit now runs `pnpm lint` automatically (Husky) — a lint failure blocks the commit.

**If you edit `packages/shared` or `packages/db` while `pnpm dev` is running**, re-run
`pnpm build --filter @regops/shared --filter @regops/db` to refresh the compiled output the other
apps consume — they import the built `dist/`, not the TypeScript source, directly.

### Demo login credentials

Two independent sets exist — **do not mix them up**, they don't work against each other's backend:

**Real backend** (`NEXT_PUBLIC_USE_MOCK_DATA=false`, or hitting `apps/api` directly) — created by
`pnpm db:seed`:

| Role | Email | Password |
| --- | --- | --- |
| SUPER_ADMIN | `superadmin@regops.dev` | `SuperAdmin!2026` |
| TENANT_ADMIN (Demo MFB Limited) | `admin@demomfb.dev` | `TenantAdmin!2026` |
| COMPLIANCE_OFFICER (Demo MFB Limited) | `compliance@demomfb.dev` | `Compliance!2026` |

Override via env vars in `apps/api/.env` (`SEED_SUPER_ADMIN_EMAIL`, etc.) — see
`apps/api/.env.example`. MFA is not enforced on seeded accounts by default; enroll via
`POST /auth/mfa/setup` → `POST /auth/mfa/enable` from a logged-in session.

**Mock frontend mode** (`NEXT_PUBLIC_USE_MOCK_DATA=true`, the default if unset — this is almost
certainly what you're using if you just cloned and ran `pnpm dev` without touching env vars) — same
password for every account, `Demo2026!`:

| Role | Email |
| --- | --- |
| SUPER_ADMIN | `superadmin@regops.dev` |
| TENANT_ADMIN | `admin@demomfb.dev` |
| VIEWER | `viewer@demomfb.dev` |
| INVESTIGATOR | `investigator@demomfb.dev` |
| COMPLIANCE_OFFICER | `compliance@demomfb.dev` |

The mock password is deliberately different from the real seed passwords so nobody assumes one
works against the other backend.

## If something looks broken, check here first

1. **`OVERNIGHT_LOG.md`** (repo root) — the detailed play-by-play of every change made overnight on
   2026-09-30, including exact judgment calls and what was explicitly *not* verified. Its "NEEDS MY
   DECISION" section at the top and final summary at the very top are the fastest way to see what's
   still open.
2. **This module status table above** — before assuming something is broken, check whether it's a
   documented, known partial (especially Reports/Screening).
3. **`HANDOFF.md`** (repo root) — the full historical build log, module-by-module, with every bug
   found and fixed during development. Much more detail than this document if you need to
   understand *why* something is built the way it is. Note: its early "GitHub Actions CI has never
   run — no remote configured" note is stale and the workflow file it refers to no longer exists —
   see "Decisions made" #2 above for the current, correct state (CI doesn't exist yet at all).
4. **Nothing runs at all** — check `docker-compose ps` (Postgres/Redis/Mailhog healthy?), that
   you've copied and filled in all three `.env` files, and that you ran `pnpm build` before
   `pnpm db:migrate` (migrations run from compiled `packages/db`, not source).
