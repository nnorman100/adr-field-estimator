-- The second lock (S3): the app's runtime role and row-level security on every table.
--
-- The app connects as its environment's IAM database user, which is granted dryscope_runtime
-- below. That role is not a table owner, has no BYPASSRLS, and sees a company's rows only inside
-- withCompany (web/src/db/tenant.ts), which sets app.company_id for one transaction. Outside it, or
-- after it, the setting is missing or '' and every policy matches nothing.
--
-- Row-level security is forced, so the table owner (the migrator) is bound by it too. No policy
-- names the owner except on migration_ledger, so a later migration that must change rows turns
-- FORCE off and on again inside its own transaction; the guard test fails if it is left off.
--
-- This file is the same in every environment. It creates the role once per database cluster and
-- grants it to the environment's API database user when one exists; in CI none exists.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dryscope_runtime') THEN
    BEGIN
      CREATE ROLE dryscope_runtime
        NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
      -- Another database in the same cluster created it at the same moment.
      NULL;
    END;
  END IF;
  -- A role of that name made some other way must not be able to skip the policies.
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'dryscope_runtime'
      AND (rolsuper OR rolbypassrls OR rolcanlogin OR rolcreaterole OR rolcreatedb OR rolreplication)
  ) THEN
    RAISE EXCEPTION 'dryscope_runtime exists with privileges it must not have';
  END IF;
END
$$;

-- The company of the current transaction, or NULL when none is set. A transaction-local setting
-- leaves '' behind on the connection after its transaction ends; that counts as none. A value
-- that is not a uuid raises an error instead of matching anything.
CREATE FUNCTION app_company_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog
  RETURN NULLIF(current_setting('app.company_id', true), '')::uuid;

REVOKE ALL ON FUNCTION app_company_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_company_id() TO dryscope_runtime;

-- Every table: row-level security on and forced.
ALTER TABLE migration_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_ledger FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies FORCE ROW LEVEL SECURITY;
ALTER TABLE actors ENABLE ROW LEVEL SECURITY;
ALTER TABLE actors FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_admins FORCE ROW LEVEL SECURITY;
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
ALTER TABLE company_feature_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_feature_flags FORCE ROW LEVEL SECURITY;
ALTER TABLE access_projection_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_projection_outbox FORCE ROW LEVEL SECURITY;

-- The ledger belongs to whoever owns it (the migrator). The runtime role has no grant on it.
CREATE POLICY migration_ledger_owner ON migration_ledger
  FOR ALL TO PUBLIC
  USING (pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'public.migration_ledger'::regclass), 'USAGE'))
  WITH CHECK (pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'public.migration_ledger'::regclass), 'USAGE'));

-- Read only for the runtime: the current company and its sign-in tenant. Changing a company or a
-- tenant is a platform operator action, which has no database context yet.
CREATE POLICY companies_current ON companies
  FOR SELECT TO dryscope_runtime
  USING (id = app_company_id());

CREATE POLICY auth_tenants_current ON auth_tenants
  FOR SELECT TO dryscope_runtime
  USING (id = (SELECT c.auth_tenant_id FROM companies c WHERE c.id = app_company_id()));

CREATE POLICY company_feature_flags_current ON company_feature_flags
  FOR SELECT TO dryscope_runtime
  USING (company_id = app_company_id());

-- Platform operators are not visible from a company.
CREATE POLICY platform_admins_none ON platform_admins
  FOR SELECT TO dryscope_runtime
  USING (false);

-- The current company's own rows. An operator actor (no company) never matches.
CREATE POLICY actors_current ON actors
  FOR ALL TO dryscope_runtime
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

CREATE POLICY invitations_current ON invitations
  FOR ALL TO dryscope_runtime
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

CREATE POLICY memberships_current ON memberships
  FOR ALL TO dryscope_runtime
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

CREATE POLICY access_projection_outbox_current ON access_projection_outbox
  FOR ALL TO dryscope_runtime
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

-- Audit rows are appended and read, never changed: the grant below has no UPDATE or DELETE.
CREATE POLICY audit_events_current ON audit_events
  FOR ALL TO dryscope_runtime
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

-- Table rights. No DELETE and no TRUNCATE anywhere: removing a business row is not a runtime
-- action, and TRUNCATE would ignore the policies.
GRANT SELECT ON companies, auth_tenants, company_feature_flags, platform_admins TO dryscope_runtime;
GRANT SELECT, INSERT, UPDATE ON actors, invitations, memberships, access_projection_outbox TO dryscope_runtime;
GRANT SELECT, INSERT ON audit_events TO dryscope_runtime;

-- The environment's API database user (dryscope-api-<env>@dryscope.iam) gets the runtime's rights
-- by inheritance and cannot SET ROLE to it or to anything else. In CI there is no such user.
DO $$
DECLARE
  api_user record;
BEGIN
  FOR api_user IN
    SELECT rolname, rolsuper, rolbypassrls FROM pg_roles
    WHERE rolname ~ '^dryscope-api-[a-z]+@dryscope\.iam$'
  LOOP
    IF api_user.rolsuper OR api_user.rolbypassrls THEN
      RAISE EXCEPTION 'API database user % must not be a superuser or bypass row-level security', api_user.rolname;
    END IF;
    EXECUTE format('GRANT dryscope_runtime TO %I WITH INHERIT TRUE, SET FALSE', api_user.rolname);
  END LOOP;
END
$$;
