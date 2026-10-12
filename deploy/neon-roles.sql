-- Run ONCE against the Neon database, connected as the project owner (neondb_owner), via the Neon SQL editor or psql.
--
-- Neon specifics (why this differs from docker/postgres-init/01-roles.sql):
--  * Roles created through the Neon Console/CLI/API are members of neon_superuser, which carries BYPASSRLS.
--    So regops_admin is created in the CONSOLE (Roles & Databases -> New role), NOT here.
--  * Roles created with plain SQL do NOT get BYPASSRLS. So regops_app is created here, which is exactly
--    what RLS enforcement needs.
--
-- Prerequisite: create role `regops_admin` in the Neon console first (and a database, e.g. `regops`,
-- owned by regops_admin). Then replace the password placeholder below and run this script.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'regops_admin') THEN
    RAISE EXCEPTION 'Create role regops_admin in the Neon console first (it needs BYPASSRLS via neon_superuser).';
  END IF;
END
$$;

-- Runtime role: no BYPASSRLS, not an owner of any table -> RLS policies apply to every query.
CREATE ROLE regops_app WITH LOGIN PASSWORD 'REPLACE_WITH_STRONG_PASSWORD' NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;

GRANT CONNECT ON DATABASE regops TO regops_app;
GRANT USAGE ON SCHEMA public TO regops_app;

-- Tables/sequences created later by regops_admin's migrations are usable by regops_app.
ALTER DEFAULT PRIVILEGES FOR ROLE regops_admin IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO regops_app;
ALTER DEFAULT PRIVILEGES FOR ROLE regops_admin IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO regops_app;

-- Verify (expect regops_admin: t, regops_app: f):
SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname IN ('regops_admin', 'regops_app');
