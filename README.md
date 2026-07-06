# RegOps

Multi-tenant AML/CFT compliance platform for Nigerian MFBs, fintechs, PSPs and mobile money
operators, built to the CBN Circular BSD/DIR/PUB/LAB/019/002 baseline standards.

This is **Phase 0**: authentication, multi-tenancy, audit logging and infrastructure only. No
domain modules (customer, screening, transaction monitoring, cases) exist yet — they arrive in
later phases (see [Roadmap](#roadmap)).

## Architecture at a glance

- **Multi-tenant by default.** Every tenant-scoped table carries `tenant_id`. Postgres
  row-level security (RLS) enforces isolation at the database layer, not just in application
  code — see [`packages/db`](packages/db) migrations.
- **Two database roles.** The API connects as `regops_app` (no `BYPASSRLS`), so every query it
  issues is subject to RLS. Migrations and seeds run as `regops_admin` (`BYPASSRLS`), which can
  freely manage schema and cross-tenant fixtures.
- **One Postgres connection per request.** `TenantContextMiddleware` opens a dedicated
  `QueryRunner` per request, stamps `app.current_tenant_id` / `app.bypass_rls` as session-local
  Postgres settings on it, and every tenant-scoped query in that request reuses that exact
  connection (via `@CurrentQueryRunner()`). Pulling a fresh connection from the pool would carry
  no RLS context.
- **Audit-first.** Every state-changing operation writes an `audit_log` row, atomically with the
  business write it documents. `audit_log` is `INSERT`-only at the database role level — `UPDATE`
  and `DELETE` are revoked from `regops_app`.

## Stack

Turborepo + pnpm workspaces · NestJS 10 + TypeORM 0.3 · PostgreSQL 15 (RLS) · Redis 7 + BullMQ ·
Next.js 15 (App Router) + Tailwind + shadcn-style UI · TanStack Query · JWT auth (argon2id +
TOTP MFA).

## Repository structure

```
apps/
  api/     NestJS HTTP API
  worker/  BullMQ worker (skeleton — one recurring maintenance job in phase 0)
  web/     Next.js console
packages/
  db/      TypeORM entities, migrations (schema + RLS), seed script
  shared/  Types/enums shared between api and web
  config/  Shared ESLint + TypeScript config
```

## Prerequisites

- Node.js 20+, pnpm 10+ (`corepack enable` will pick up the pinned version)
- Docker + Docker Compose (Postgres, Redis, Mailhog)

## Getting started

```bash
git clone <this-repo> regops && cd regops
pnpm install

cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
cp apps/worker/.env.example apps/worker/.env
# Edit apps/api/.env: JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must each be a
# distinct random string of 64+ characters. Generate with e.g.:
#   openssl rand -hex 64

docker-compose up -d      # postgres:5433, redis:6379, mailhog:8025
pnpm build                # compiles packages/shared and packages/db (apps import compiled dist)
pnpm db:migrate           # applies schema + RLS policies (see packages/db/src/migrations)
pnpm db:seed              # creates the accounts below

pnpm dev                  # api on :4000, web on :3000, worker on :4001
```

Open http://localhost:3000, log in with one of the seeded accounts, and you should land on the
placeholder dashboard showing your user, role and tenant.

### Seeded accounts

`pnpm db:seed` creates a platform tenant (home of the super admin) and a demo tenant, "Demo MFB
Limited", with the following accounts (override via env vars in `apps/api/.env`, see
`.env.example`):

| Role | Email | Password |
| --- | --- | --- |
| SUPER_ADMIN | `superadmin@regops.dev` | `SuperAdmin!2026` |
| TENANT_ADMIN (Demo MFB Limited) | `admin@demomfb.dev` | `TenantAdmin!2026` |
| COMPLIANCE_OFFICER (Demo MFB Limited) | `compliance@demomfb.dev` | `Compliance!2026` |

MFA is not enabled on seeded accounts by default — log in, then visit `POST /auth/mfa/setup` →
scan the QR code → `POST /auth/mfa/enable` to turn it on. SUPER_ADMIN, TENANT_ADMIN and
COMPLIANCE_OFFICER are the roles for which MFA is mandatory in production use; phase 0 does not
yet block login for non-enrolled accounts in those roles (see `AuthService` comments) — the
console nudges enrollment instead.

## Everyday commands

```bash
pnpm dev            # run all apps in watch mode
pnpm build           # build all apps/packages
pnpm lint            # eslint across the monorepo
pnpm typecheck       # tsc --noEmit across the monorepo
pnpm test            # unit tests (no DB required)
pnpm test:e2e        # integration tests (require docker-compose up + pnpm db:migrate)
pnpm db:migrate      # apply pending migrations
pnpm db:revert       # revert the last migration
pnpm db:seed         # (re-)create the seed tenants/users above
```

API docs (Swagger) are served at http://localhost:4000/docs outside of production.

> If you edit `packages/shared` or `packages/db` while `pnpm dev` is already running, re-run
> `pnpm build --filter @regops/shared --filter @regops/db` to refresh the compiled output the
> other apps consume.

## Testing multi-tenancy and RLS

`apps/api/test/tenant-isolation.e2e-spec.ts` and `apps/api/test/audit.e2e-spec.ts` exercise the
RLS policies directly — including a raw SQL query issued as `regops_app` from tenant A's session
context against tenant B's data (expects 0 rows) and a direct `UPDATE`/`DELETE` against
`audit_log` (expects `permission denied`). These require the real Postgres from
`docker-compose.yml` with migrations applied; they are not mocked.

`apps/api/test/auth.e2e-spec.ts` covers login, lockout, refresh-token rotation and theft
detection (reusing a rotated-away refresh token revokes the whole token family for that user),
and the MFA challenge/verify flow.

## Known limitations (phase 0)

- **Login is by email only** (no tenant selector). The schema enforces email uniqueness
  *per tenant*, so if the same email were ever provisioned in two tenants, login could not
  disambiguate and would reject with `INVALID_CREDENTIALS`. Seeded/demo data never collides.
  A later phase can add tenant-scoped login (subdomain or explicit tenant id) if this becomes a
  real requirement.
- **Account lockout window** ("5 failures in 15 minutes") is approximated using the user row's
  `updated_at` timestamp, since the schema (as specified) has no dedicated
  last-failed-attempt column. See the comment in `AuthService.recordFailedAttempt`.
- `apps/worker` ships only the BullMQ skeleton plus the one job phase 0 itself depends on:
  pre-creating future `audit_log` quarterly partitions.

## Roadmap

Phase 0 (this repo) is the foundation every later phase builds on top of — the non-negotiables in
this README (multi-tenancy, audit logging, idempotency, RLS) apply to all of them:

2. Customer + Risk Rating
3. Screening (Strategy + Registry pattern)
4. Transaction Ingestion (SFTP + webhook)
5. Rules Engine + 5 scenarios
6. Case Management
7. SAR/CTR Generation (NFIU goAML XML)
8–10. Next.js console pages (customers, alerts, cases, reports, dashboards)
