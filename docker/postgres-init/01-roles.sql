-- Creates the two application roles used by RegOps.
-- regops_admin: BYPASSRLS, owns the schema, runs migrations and seeds.
-- regops_app:   NO BYPASSRLS, used by the running API so Postgres RLS is enforced.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'regops_admin') THEN
    CREATE ROLE regops_admin WITH LOGIN PASSWORD 'regops_admin_password' BYPASSRLS CREATEDB;
  END IF;

  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'regops_app') THEN
    CREATE ROLE regops_app WITH LOGIN PASSWORD 'regops_app_password' NOBYPASSRLS;
  END IF;
END
$$;

GRANT ALL PRIVILEGES ON DATABASE regops TO regops_admin;
GRANT CONNECT ON DATABASE regops TO regops_app;

ALTER DATABASE regops OWNER TO regops_admin;

-- Default privileges so future tables created by regops_admin are usable by regops_app.
ALTER DEFAULT PRIVILEGES FOR ROLE regops_admin IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO regops_app;

ALTER DEFAULT PRIVILEGES FOR ROLE regops_admin IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO regops_app;

GRANT USAGE ON SCHEMA public TO regops_app;
