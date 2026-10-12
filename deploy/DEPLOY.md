# Deploying RegOps backend: Neon + Railway + Cloudinary

Neon = Postgres. Railway = API service, worker service, Redis. Cloudinary = file storage.

## 1. Neon (Postgres) — DONE for project `ep-aged-silence-b7kmk7pw`

- Database `neondb`. `neondb_owner` (console-created, so BYPASSRLS) is the admin role: it runs migrations and the worker.
- `regops_app` (created with SQL, NOBYPASSRLS, not a table owner) is the API runtime role, so RLS applies. Script: `deploy/neon-roles.sql` (the version actually run used `neondb_owner` as the admin role; adapt the names if you use a dedicated `regops_admin`).
- All 11 migrations applied. Use the **direct** (non-pooled) connection string for both URLs; RLS relies on per-request session settings.
- Generated connection strings and JWT secrets are in `backend/.env.production.local` (git-ignored). Copy values from there into Railway variables; never commit it.

## 2. Cloudinary

Env: `CLOUDINARY_URL=cloudinary://<api_key>:<api_secret>@<cloud_name>` (Console -> API Keys), optional `CLOUDINARY_ROOT_FOLDER=regops-prod`.
Files are stored as `raw` assets with `authenticated` delivery type (not publicly reachable); downloads are proxied by the API.
Limits: free-plan raw upload cap is 10 MB (large customer/transaction CSVs may need a paid plan), and `list()` uses the Admin API (rate limited), which the SFTP-inbox poller calls every 5/30 minutes.
With `NODE_ENV=production` the API and worker refuse to start without `CLOUDINARY_URL`.

## 3. Railway

One project, three services from this repo (root directory = repo root):

| Service | Config file path (Settings -> Config as code) | Notes |
|---|---|---|
| `redis` | n/a (Redis template) | Eviction policy `noeviction` (BullMQ requirement). |
| `api` | `/deploy/railway.api.json` | Runs `pnpm db:migrate` as a pre-deploy step. Needs a public domain. |
| `worker` | `/deploy/railway.worker.json` | No public domain needed. |

| Variable | api | worker | Value |
|---|---|---|---|
| `NODE_ENV` | yes | yes | `production` |
| `DATABASE_URL` | yes | no | `regops_app` direct URL (from `.env.production.local`) |
| `DATABASE_ADMIN_URL` | yes | yes | `neondb_owner` direct URL |
| `REDIS_URL` | yes | yes | `${{redis.REDIS_URL}}` (private network) |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | yes | no | From `.env.production.local` |
| `CORS_ORIGINS` | yes | no | Frontend origin(s), comma-separated, no trailing slash |
| `CLOUDINARY_URL` | yes | yes | See section 2 |

Do **not** set `SEED_*` or run `pnpm db:seed` in production: the current seed creates demo tenant data with fixed passwords. A first-Super-Admin bootstrap is still to be built (task B/D).

Notes baked into the code/config:
- Build uses `--prod=false` because Railway sets `NODE_ENV=production` at build time, which would otherwise skip the dev dependencies the build needs.
- Redis connections use dual-stack DNS (`family: 0`) because Railway's private network is IPv6-only, and honour `rediss://` URLs.
- Swagger (`/docs`) is disabled when `NODE_ENV=production`.

## 4. Verify

1. api deploy logs show migrations already applied, then `RegOps API listening`.
2. worker logs show `RegOps worker listening on queues ...`.
3. Upload a CSV through the API and confirm the worker processes it (proves shared storage + Redis).

## Unverified

The Railway config files, the monorepo build command and the Cloudinary adapter haven't been run against real services. Expect to adjust on the first deploy.
